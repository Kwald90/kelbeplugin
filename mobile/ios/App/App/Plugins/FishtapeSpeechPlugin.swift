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
        DispatchQueue.main.async { self.endSession(); call.resolve() }
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
            if let result = result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    if !text.isEmpty { self.notifyListeners("final", data: ["text": text]) }
                } else if !text.isEmpty {
                    self.notifyListeners("partial", data: ["text": text])
                }
            }
            // A task ends on a natural pause (isFinal) or a no-speech timeout (error). While we are
            // still running, start a fresh task so dictation carries on; otherwise surface the error.
            if result?.isFinal == true || error != nil {
                DispatchQueue.main.async {
                    guard self.running else {
                        if let error = error { self.notifyListeners("speechError", data: ["message": error.localizedDescription]) }
                        return
                    }
                    self.task = nil
                    self.request = nil
                    self.startRecognition()
                }
            }
        }
    }

    @MainActor
    private func endSession() {
        running = false
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
