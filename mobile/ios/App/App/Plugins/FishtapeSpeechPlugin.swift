import Capacitor
import Speech
import AVFoundation

/// FishtapeSpeech: live, on-device dictation while a site walkthrough records. The web view's own
/// Web Speech API is not available inside WKWebView, so electrical-app/js/lib/transcribe.js routes to
/// this plugin in the iOS app and falls back to Web Speech elsewhere. Contract:
///
///     available() -> { available: boolean }        // a recognizer exists and is reachable
///     start({ lang }) -> { started: true }          // asks permission, begins listening
///     stop() -> {}                                   // ends listening, frees the mic
///
/// Events (notifyListeners):
///     "partial"      { text }     the in-progress phrase, replaced as it firms up
///     "final"        { text }     a settled phrase; the web app appends it to the transcript
///     "speechError"  { message }  recognition stopped for a reason other than a natural pause
///
/// The audio session is configured .playAndRecord with .mixWithOthers so the walkthrough video keeps
/// recording its own audio track at the same time. Recognition prefers on-device so it works with no
/// signal on a job site. SFSpeechRecognizer finalises a task on each natural pause; we start a fresh
/// task so dictation continues for the whole walk.
@objc(FishtapeSpeechPlugin)
public class FishtapeSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapeSpeechPlugin"
    public let jsName = "FishtapeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false
    private var lang = "en-CA"
    // The latest uncommitted phrase for the current recognition segment. On-device recognition can
    // run a long time without ever reporting isFinal, so we rotate the task on a timer to settle the
    // text periodically; `pending` is what hasn't been emitted as "final" yet.
    private var pending = ""
    private var rotateTimer: Timer?
    // Settle the current phrase this often so the transcript saves as the walk goes, not only at stop.
    private let rotateInterval: TimeInterval = 20

    @objc func available(_ call: CAPPluginCall) {
        let r = SFSpeechRecognizer(locale: Locale(identifier: call.getString("lang") ?? "en-CA")) ?? SFSpeechRecognizer()
        call.resolve(["available": r?.isAvailable ?? false])
    }

    @objc func start(_ call: CAPPluginCall) {
        lang = call.getString("lang") ?? "en-CA"
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("Speech recognition is off. Turn it on for Fishtape in Settings.", "not_authorized")
                return
            }
            let proceed = { (granted: Bool) in
                guard granted else { call.reject("Microphone access is off for Fishtape.", "no_mic"); return }
                DispatchQueue.main.async {
                    do { try self.beginSession(); call.resolve(["started": true]) }
                    catch { call.reject("Couldn't start live transcription: \(error.localizedDescription)", "start_failed") }
                }
            }
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { proceed($0) }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { proceed($0) }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Hand back the last in-progress phrase so the web app can append it: the recognition
            // task is about to be cancelled, so this is the one place it won't arrive as a "final".
            let tail = self.pending
            self.pending = ""
            self.endSession()
            call.resolve(["tail": tail])
        }
    }

    @MainActor
    private func beginSession() throws {
        endSession()
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: lang)) ?? SFSpeechRecognizer(), rec.isAvailable else {
            throw NSError(domain: "FishtapeSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "No speech recognizer is available."])
        }
        recognizer = rec

        // Mixable record session so the walkthrough video keeps capturing its own audio.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        // One mic tap for the whole session; it feeds whichever request is current.
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
        running = true
        startRecognition()

        // Settle the current phrase periodically so the transcript is saved as the walk goes. On-device
        // recognition can run minutes without an isFinal, so without this the whole walk would sit in
        // one partial and only land when the user stops — and a cancel on stop would lose it entirely.
        rotateTimer?.invalidate()
        rotateTimer = Timer.scheduledTimer(withTimeInterval: rotateInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.rotate() }
        }
    }

    @MainActor
    private func startRecognition() {
        guard running, let rec = recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result, !result.isFinal {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty { self.pending = text; self.notifyListeners("partial", data: ["text": text]) }
            }
            // A task ends on a natural pause (isFinal), our timed rotation (endAudio), or a no-speech
            // timeout (error). Whichever it is, commit whatever has built up as a settled phrase, then
            // start a fresh task so dictation carries on for the whole walk.
            if result?.isFinal == true || error != nil {
                let settled = (result?.isFinal == true) ? result!.bestTranscription.formattedString : self.pending
                self.pending = ""
                if !settled.isEmpty { self.notifyListeners("final", data: ["text": settled]) }
                DispatchQueue.main.async {
                    guard self.running else {
                        if settled.isEmpty, let error = error { self.notifyListeners("speechError", data: ["message": error.localizedDescription]) }
                        return
                    }
                    self.task = nil
                    self.request = nil
                    self.startRecognition()
                }
            }
        }
    }

    /// End the current recognition request so its text settles (fires isFinal in the task callback,
    /// which commits the phrase and starts a fresh task). Clearing `request` first stops the mic tap
    /// feeding a request that has already had endAudio() called on it.
    @MainActor
    private func rotate() {
        guard running, let req = request else { return }
        request = nil
        req.endAudio()
    }

    @MainActor
    private func endSession() {
        running = false
        rotateTimer?.invalidate()
        rotateTimer = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognizer = nil
        // Hand the audio session back so the web view's recording isn't left sharing it.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
