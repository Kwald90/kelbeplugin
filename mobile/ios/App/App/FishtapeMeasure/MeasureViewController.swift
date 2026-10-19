import ARKit
import SceneKit
import UIKit

enum MeasureOutcome {
    case done([String: Any])
    case cancelled
    case failed(message: String, code: String)
}

private enum Palette {
    static let accent = UIColor(red: 0.961, green: 0.702, blue: 0.004, alpha: 1) // --accent-fill #f5b301
    static let ink = UIColor(red: 0.110, green: 0.106, blue: 0.098, alpha: 1)    // #1c1b19
    static let scrim = UIColor.black.withAlphaComponent(0.6)
}

/// Full-screen AR tape. Aim the centre dot at a wall, floor or conduit, add a point at each end and
/// at every bend, then tap Done. Built for gloves: big buttons, and a tap anywhere on the camera view
/// adds a point too.
///
/// Points are raycast from the screen centre: detected planes and estimated planes, and on LiDAR
/// devices the reconstructed mesh, so plain drywall works better there.
final class MeasureViewController: UIViewController {
    var onFinish: ((MeasureOutcome) -> Void)?

    private let units: MeasureUnits
    private let sceneView = ARSCNView(frame: .zero)
    private let coaching = ARCoachingOverlayView()

    // world (metres, ARKit world space)
    private var points: [SIMD3<Float>] = []
    private var pointNodes: [SCNNode] = []
    private var segmentNodes: [SCNNode] = []
    private let reticleNode = MeasureViewController.makeReticle()
    private let liveNode = MeasureViewController.makeLine(color: .white, radius: 0.001)
    private var aim: SIMD3<Float>?

    // state
    private var started = false
    private var finished = false
    private var interrupted = false
    private var trackingNote: String?
    private var hint: (text: String, until: Date)?
    private var compactLayout: Bool?

    // overlay
    private let labelLayer = UIView()
    private var segmentLabels: [PillLabel] = []
    private let liveLabel = PillLabel(style: .live)
    private let crosshair = CrosshairView()
    private let panel = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
    private let captionLabel = UILabel()
    private let totalLabel = UILabel()
    private let legLabel = UILabel()
    private let statusLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let addButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let controls = UIStackView()
    private let secondary = UIStackView()
    private var regularConstraints: [NSLayoutConstraint] = []
    private var compactConstraints: [NSLayoutConstraint] = []
    private let impact = UIImpactFeedbackGenerator(style: .medium)
    private let notice = UINotificationFeedbackGenerator()

    init(units: MeasureUnits) {
        self.units = units
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        sceneView.automaticallyUpdatesLighting = false
        sceneView.autoenablesDefaultLighting = false
        sceneView.session.delegate = self
        sceneView.scene.rootNode.addChildNode(reticleNode)
        sceneView.scene.rootNode.addChildNode(liveNode)
        reticleNode.isHidden = true
        liveNode.isHidden = true
        fill(sceneView)

        labelLayer.isUserInteractionEnabled = false
        liveLabel.isHidden = true
        labelLayer.addSubview(liveLabel)
        fill(labelLayer)

        crosshair.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(crosshair)
        NSLayoutConstraint.activate([
            crosshair.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            crosshair.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            crosshair.widthAnchor.constraint(equalToConstant: 44),
            crosshair.heightAnchor.constraint(equalToConstant: 44)
        ])

        coaching.session = sceneView.session
        coaching.goal = .anyPlane
        coaching.activatesAutomatically = true
        coaching.delegate = self
        fill(coaching)

        buildPanel()
        buildControls()
        layoutOverlay()

        let tap = UITapGestureRecognizer(target: self, action: #selector(addPoint))
        tap.delegate = self
        view.addGestureRecognizer(tap)

        refreshTotals()
        updateStatus()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        if !started {
            started = true
            startSession(reset: true)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        impact.prepare()
        notice.prepare()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed {
            UIApplication.shared.isIdleTimerDisabled = false
            sceneView.session.pause()
        }
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        // Phones in landscape: controls move to a column on the right so they don't cover the dot.
        let compact = traitCollection.verticalSizeClass == .compact
        guard compact != compactLayout else { return }
        compactLayout = compact
        NSLayoutConstraint.deactivate(compact ? regularConstraints : compactConstraints)
        NSLayoutConstraint.activate(compact ? compactConstraints : regularConstraints)
        secondary.axis = compact ? .vertical : .horizontal
    }

    private func startSession(reset: Bool) {
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        if Self.hasLiDAR {
            // LiDAR iPhones and iPads: estimated-plane raycasts follow the reconstructed mesh.
            config.sceneReconstruction = .mesh
        }
        sceneView.session.run(config, options: reset ? [.resetTracking, .removeExistingAnchors] : [])
    }

    private static var hasLiDAR: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    // MARK: - Overlay

    private func fill(_ child: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(child)
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: view.topAnchor),
            child.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            child.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    private func buildPanel() {
        panel.layer.cornerRadius = 20
        panel.clipsToBounds = true
        panel.translatesAutoresizingMaskIntoConstraints = false

        captionLabel.text = "TOTAL"
        captionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        captionLabel.textColor = UIColor.white.withAlphaComponent(0.7)

        totalLabel.font = .monospacedDigitSystemFont(ofSize: 36, weight: .bold)
        totalLabel.textColor = .white
        totalLabel.adjustsFontSizeToFitWidth = true
        totalLabel.minimumScaleFactor = 0.6

        legLabel.font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        legLabel.textColor = Palette.accent

        statusLabel.font = .systemFont(ofSize: 16, weight: .medium)
        statusLabel.textColor = .white
        statusLabel.numberOfLines = 3

        let stack = UIStackView(arrangedSubviews: [captionLabel, totalLabel, legLabel, statusLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.setCustomSpacing(8, after: legLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: panel.contentView.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: panel.contentView.bottomAnchor, constant: -14),
            stack.leadingAnchor.constraint(equalTo: panel.contentView.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: panel.contentView.trailingAnchor, constant: -18)
        ])
        view.addSubview(panel)
    }

    private func buildControls() {
        style(addButton, title: "Add point", symbol: "plus.circle.fill", background: Palette.accent, foreground: Palette.ink, size: 22)
        style(undoButton, title: "Undo", symbol: "arrow.uturn.backward", background: Palette.scrim, foreground: .white, size: 19)
        style(doneButton, title: "Done", symbol: "checkmark", background: .white, foreground: Palette.ink, size: 19)
        style(cancelButton, title: "Cancel", symbol: "xmark", background: Palette.scrim, foreground: .white, size: 18)
        addButton.accessibilityHint = "Drops a point where the centre dot is. You can also tap anywhere on the camera view."
        doneButton.accessibilityHint = "Finishes and sends the length to the wire run."

        addButton.addTarget(self, action: #selector(addPoint), for: .touchUpInside)
        undoButton.addTarget(self, action: #selector(undo), for: .touchUpInside)
        doneButton.addTarget(self, action: #selector(done), for: .touchUpInside)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        secondary.addArrangedSubview(undoButton)
        secondary.addArrangedSubview(doneButton)
        secondary.axis = .horizontal
        secondary.distribution = .fillEqually
        secondary.spacing = 12

        controls.addArrangedSubview(addButton)
        controls.addArrangedSubview(secondary)
        controls.axis = .vertical
        controls.spacing = 12
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)

        // Above the coaching overlay, so there is always a way out.
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)
    }

    private func style(_ button: UIButton, title: String, symbol: String, background: UIColor, foreground: UIColor, size: CGFloat) {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .bold))
        config.imagePadding = 10
        config.baseBackgroundColor = background
        config.baseForegroundColor = foreground
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 22, bottom: 14, trailing: 22)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var attributes = incoming
            attributes.font = UIFont.systemFont(ofSize: size, weight: .bold)
            return attributes
        }
        button.configuration = config
        button.accessibilityLabel = title
    }

    private func layoutOverlay() {
        let guide = view.safeAreaLayoutGuide
        let panelWidth = panel.widthAnchor.constraint(equalToConstant: 440)
        panelWidth.priority = .defaultLow
        let controlsWidth = controls.widthAnchor.constraint(equalToConstant: 440)
        controlsWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            cancelButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            cancelButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),

            panel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            panel.leadingAnchor.constraint(greaterThanOrEqualTo: cancelButton.trailingAnchor, constant: 12),
            panel.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
            panelWidth,

            addButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 76),
            undoButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 62),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 62)
        ])
        regularConstraints = [
            panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            controls.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            controls.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -16),
            controls.widthAnchor.constraint(lessThanOrEqualTo: guide.widthAnchor, constant: -32),
            controlsWidth
        ]
        let panelLeading = panel.leadingAnchor.constraint(equalTo: cancelButton.trailingAnchor, constant: 12)
        panelLeading.priority = UILayoutPriority(UILayoutPriority.defaultLow.rawValue - 1)
        compactConstraints = [
            panelLeading,
            controls.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            controls.centerYAnchor.constraint(equalTo: guide.centerYAnchor),
            controls.widthAnchor.constraint(equalToConstant: 210),
            panel.trailingAnchor.constraint(lessThanOrEqualTo: controls.leadingAnchor, constant: -16)
        ]
    }

    /// Hide the measuring controls while ARKit's coaching overlay is up (Cancel stays).
    private func setMeasuringVisible(_ visible: Bool) {
        UIView.animate(withDuration: 0.25) {
            for item in [self.panel, self.controls, self.crosshair, self.labelLayer] as [UIView] {
                item.alpha = visible ? 1 : 0
            }
        }
    }

    // MARK: - Actions

    @objc private func addPoint() {
        guard !finished, !coaching.isActive else { return }
        guard let aim else {
            say("No surface under the dot yet. Move slowly so the camera can find it.")
            notice.notificationOccurred(.warning)
            return
        }
        if let last = points.last, simd_distance(last, aim) < 0.005 {
            return // a double tap on the same spot
        }
        points.append(aim)
        let dot = Self.makePoint()
        dot.simdPosition = aim
        sceneView.scene.rootNode.addChildNode(dot)
        pointNodes.append(dot)
        if points.count >= 2 {
            let line = Self.makeLine(color: Palette.accent, radius: 0.0015)
            sceneView.scene.rootNode.addChildNode(line)
            segmentNodes.append(line)
            let label = PillLabel(style: .segment)
            label.text = MeasureFormat.length(legs.last ?? 0, units: units)
            labelLayer.addSubview(label)
            segmentLabels.append(label)
        }
        impact.impactOccurred()
        refreshTotals()
        UIAccessibility.post(notification: .announcement, argument: "Point \(points.count). Total \(totalLabel.text ?? "")")
    }

    @objc private func undo() {
        guard !finished, !points.isEmpty else { return }
        points.removeLast()
        pointNodes.removeLast().removeFromParentNode()
        if segmentNodes.count > max(0, points.count - 1) {
            segmentNodes.removeLast().removeFromParentNode()
            segmentLabels.removeLast().removeFromSuperview()
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        refreshTotals()
    }

    @objc private func done() {
        guard !finished else { return }
        guard points.count >= 2 else {
            say("Add at least two points first.")
            notice.notificationOccurred(.warning)
            return
        }
        reticleNode.isHidden = true
        liveNode.isHidden = true
        liveLabel.isHidden = true
        let snapshot = makeSnapshot()
        notice.notificationOccurred(.success)
        finish(.done(result(snapshot: snapshot)))
    }

    @objc private func cancel() {
        guard !finished else { return }
        guard !points.isEmpty else {
            finish(.cancelled)
            return
        }
        let alert = UIAlertController(
            title: "Discard this measurement?",
            message: points.count == 1 ? "The point you added will be lost." : "The \(points.count) points you added will be lost.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep measuring", style: .cancel))
        alert.addAction(UIAlertAction(title: "Discard", style: .destructive) { [weak self] _ in
            self?.finish(.cancelled)
        })
        present(alert, animated: true)
    }

    private func finish(_ outcome: MeasureOutcome) {
        guard !finished else { return }
        finished = true
        sceneView.session.pause()
        UIApplication.shared.isIdleTimerDisabled = false
        let callback = onFinish
        onFinish = nil
        callback?(outcome)
        // dismiss from the presenter, so an alert this screen is showing goes too
        (presentingViewController ?? self).dismiss(animated: true)
    }

    private func clearPoints() {
        points.removeAll()
        (pointNodes + segmentNodes).forEach { $0.removeFromParentNode() }
        pointNodes.removeAll()
        segmentNodes.removeAll()
        segmentLabels.forEach { $0.removeFromSuperview() }
        segmentLabels.removeAll()
        refreshTotals()
    }

    private func say(_ text: String) {
        hint = (text, Date().addingTimeInterval(2.5))
        updateStatus()
    }

    // MARK: - Per frame

    private var legs: [Double] {
        zip(points, points.dropFirst()).map { Double(simd_distance($0, $1)) }
    }

    private var totalMetres: Double {
        legs.reduce(0, +)
    }

    private func refreshTotals() {
        totalLabel.text = MeasureFormat.length(totalMetres, units: units)
        undoButton.isEnabled = !points.isEmpty
        doneButton.isEnabled = points.count >= 2
    }

    private func frameUpdate() {
        guard !finished, let camera = sceneView.pointOfView else { return }
        let eye = camera.simdWorldPosition
        updateAim(eye: eye)
        updateScene(eye: eye)
        updateLabels(eye: eye, front: camera.simdWorldFront)
        updateStatus()
    }

    private func updateAim(eye: SIMD3<Float>) {
        let centre = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
        guard let hit = raycast(from: centre) else {
            aim = nil
            reticleNode.isHidden = true
            crosshair.locked = false
            return
        }
        let column = hit.worldTransform.columns.3
        let p = SIMD3<Float>(column.x, column.y, column.z)
        // Ease toward small moves so the dot doesn't jitter; jump when aimed somewhere new.
        if let previous = aim, simd_distance(previous, p) < 0.04 {
            aim = simd_mix(previous, p, SIMD3<Float>(repeating: 0.35))
        } else {
            aim = p
        }
        guard let aim else { return }
        var transform = hit.worldTransform
        transform.columns.3 = SIMD4<Float>(aim.x, aim.y, aim.z, 1)
        reticleNode.simdTransform = transform
        reticleNode.simdScale = SIMD3<Float>(repeating: thickness(at: aim, eye: eye))
        reticleNode.isHidden = false
        crosshair.locked = true
    }

    /// Detected planes and estimated planes. LiDAR devices try estimated planes first, because those
    /// follow the scene mesh; other devices prefer detected planes, which are steadier.
    private func raycast(from point: CGPoint) -> ARRaycastResult? {
        let targets: [ARRaycastQuery.Target] = Self.hasLiDAR
            ? [.estimatedPlane, .existingPlaneGeometry]
            : [.existingPlaneGeometry, .estimatedPlane]
        for target in targets {
            guard let query = sceneView.raycastQuery(from: point, allowing: target, alignment: .any) else { continue }
            if let hit = sceneView.session.raycast(query).first {
                return hit
            }
        }
        return nil
    }

    /// Lines, dots and the ring get thicker with distance so they stay visible across a room.
    private func thickness(at p: SIMD3<Float>, eye: SIMD3<Float>) -> Float {
        max(1, min(6, simd_distance(p, eye) / 0.6))
    }

    private func updateScene(eye: SIMD3<Float>) {
        for (i, node) in segmentNodes.enumerated() where i + 1 < points.count {
            place(node, from: points[i], to: points[i + 1], eye: eye)
        }
        for (i, node) in pointNodes.enumerated() where i < points.count {
            node.simdScale = SIMD3<Float>(repeating: thickness(at: points[i], eye: eye))
        }
        if let last = points.last, let aim {
            place(liveNode, from: last, to: aim, eye: eye)
        } else {
            liveNode.isHidden = true
        }
    }

    private func place(_ node: SCNNode, from a: SIMD3<Float>, to b: SIMD3<Float>, eye: SIMD3<Float>) {
        let d = b - a
        let length = simd_length(d)
        guard length > 0.001 else {
            node.isHidden = true
            return
        }
        let k = thickness(at: (a + b) / 2, eye: eye)
        node.simdPosition = (a + b) / 2
        node.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 1, 0), to: d / length)
        node.simdScale = SIMD3<Float>(k, length, k)
        node.isHidden = false
    }

    private func updateLabels(eye: SIMD3<Float>, front: SIMD3<Float>) {
        for (i, label) in segmentLabels.enumerated() where i + 1 < points.count {
            show(label, at: (points[i] + points[i + 1]) / 2, eye: eye, front: front)
        }
        if let last = points.last, let aim, simd_distance(last, aim) > 0.01 {
            liveLabel.text = MeasureFormat.length(Double(simd_distance(last, aim)), units: units)
            show(liveLabel, at: (last + aim) / 2, eye: eye, front: front)
        } else {
            liveLabel.isHidden = true
        }
    }

    private func show(_ label: PillLabel, at p: SIMD3<Float>, eye: SIMD3<Float>, front: SIMD3<Float>) {
        guard simd_dot(p - eye, front) > 0.05 else {
            label.isHidden = true // behind the camera
            return
        }
        let s = sceneView.projectPoint(SCNVector3(p))
        let centre = CGPoint(x: CGFloat(s.x), y: CGFloat(s.y))
        label.center = centre
        label.isHidden = !sceneView.bounds.insetBy(dx: -40, dy: -40).contains(centre)
    }

    private func updateStatus() {
        let text: String
        if interrupted {
            text = "AR paused. Point back at where you were measuring."
        } else if let hint, hint.until > Date() {
            text = hint.text
        } else if let trackingNote {
            text = trackingNote
        } else if aim == nil {
            text = "Aim the dot at the wall, floor or conduit, and move slowly."
        } else if points.isEmpty {
            text = "Tap Add point, or anywhere, to drop the first point."
        } else if points.count == 1 {
            text = "Add a point at each bend and at the end."
        } else {
            text = "Add more points, or tap Done."
        }
        if statusLabel.text != text {
            statusLabel.text = text
        }
        var leg = " "
        if let last = points.last, let aim {
            leg = "+ " + MeasureFormat.length(Double(simd_distance(last, aim)), units: units)
        }
        if legLabel.text != leg {
            legLabel.text = leg
        }
    }

    // MARK: - Result

    private func result(snapshot: String?) -> [String: Any] {
        let lengths = legs
        var out: [String: Any] = [
            "totalM": lengths.reduce(0, +),
            "segments": lengths.map { ["lengthM": $0] },
            "points": points.map { ["x": Double($0.x), "y": Double($0.y), "z": Double($0.z)] }
        ]
        if let snapshot {
            out["snapshot"] = snapshot
        }
        return out
    }

    /// The AR view with the segment lengths and the total drawn on, as a JPEG data URL no larger
    /// than 1280 px on its long side (and about 400 KB).
    private func makeSnapshot() -> String? {
        SCNTransaction.flush()
        let shot = sceneView.snapshot()
        guard shot.size.width > 0, shot.size.height > 0 else { return nil }
        let pills = segmentLabels.filter { !$0.isHidden }.map { ($0.text ?? "", $0.center) }
        let total = "Total " + MeasureFormat.length(totalMetres, units: units)

        let format = UIGraphicsImageRendererFormat()
        format.scale = shot.scale
        format.opaque = true
        let composed = UIGraphicsImageRenderer(size: shot.size, format: format).image { _ in
            shot.draw(at: .zero)
            for (text, centre) in pills {
                Self.drawPill(text, centre: centre, size: 17, foreground: Palette.ink, background: .white)
            }
            let font = UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .bold)
            let width = (total as NSString).size(withAttributes: [.font: font]).width
            Self.drawPill(total, centre: CGPoint(x: 16 + 14 + width / 2, y: 36), size: 22, foreground: Palette.ink, background: Palette.accent)
        }

        let pixels = CGSize(width: shot.size.width * shot.scale, height: shot.size.height * shot.scale)
        let k = min(1, 1280 / max(pixels.width, pixels.height))
        let target = CGSize(width: (pixels.width * k).rounded(), height: (pixels.height * k).rounded())
        let small = UIGraphicsImageRendererFormat()
        small.scale = 1
        small.opaque = true
        let image = UIGraphicsImageRenderer(size: target, format: small).image { _ in
            composed.draw(in: CGRect(origin: .zero, size: target))
        }
        var quality: CGFloat = 0.8
        var data = image.jpegData(compressionQuality: quality)
        while let bytes = data, bytes.count > 400_000, quality > 0.35 {
            quality -= 0.1
            data = image.jpegData(compressionQuality: quality)
        }
        guard let jpeg = data else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    private static func drawPill(_ text: String, centre: CGPoint, size: CGFloat, foreground: UIColor, background: UIColor) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedDigitSystemFont(ofSize: size, weight: .bold),
            .foregroundColor: foreground
        ]
        let textSize = (text as NSString).size(withAttributes: attributes)
        let rect = CGRect(x: centre.x - textSize.width / 2 - 14, y: centre.y - textSize.height / 2 - 6,
                          width: textSize.width + 28, height: textSize.height + 12)
        background.setFill()
        UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2).fill()
        (text as NSString).draw(at: CGPoint(x: rect.minX + 14, y: rect.minY + 6), withAttributes: attributes)
    }

    // MARK: - Scene nodes

    private static func constantMaterial(_ color: UIColor) -> SCNMaterial {
        let material = SCNMaterial()
        material.diffuse.contents = color
        material.lightingModel = .constant
        // drawn over the surfaces they sit on, never hidden inside them
        material.readsFromDepthBuffer = false
        material.writesToDepthBuffer = false
        return material
    }

    /// A unit-height cylinder along Y; place() stretches it between two points.
    private static func makeLine(color: UIColor, radius: CGFloat) -> SCNNode {
        let cylinder = SCNCylinder(radius: radius, height: 1)
        cylinder.radialSegmentCount = 12
        cylinder.materials = [constantMaterial(color)]
        let node = SCNNode(geometry: cylinder)
        node.renderingOrder = 10
        return node
    }

    private static func makePoint() -> SCNNode {
        let sphere = SCNSphere(radius: 0.004)
        sphere.segmentCount = 16
        sphere.materials = [constantMaterial(.white)]
        let node = SCNNode(geometry: sphere)
        node.renderingOrder = 11
        return node
    }

    /// A ring lying flat on the surface (the hit's Y axis is the surface normal) with a centre dot.
    private static func makeReticle() -> SCNNode {
        let ring = SCNTorus(ringRadius: 0.02, pipeRadius: 0.0012)
        ring.materials = [constantMaterial(UIColor.white.withAlphaComponent(0.95))]
        let ringNode = SCNNode(geometry: ring)
        ringNode.renderingOrder = 12
        let centre = SCNCylinder(radius: 0.0025, height: 0.0002)
        centre.materials = [constantMaterial(Palette.accent)]
        let centreNode = SCNNode(geometry: centre)
        centreNode.renderingOrder = 12
        let node = SCNNode()
        node.addChildNode(ringNode)
        node.addChildNode(centreNode)
        return node
    }
}

// MARK: - ARSessionDelegate

// ARKit calls these on the main queue (the session's delegateQueue is nil).
extension MeasureViewController: ARSessionDelegate {
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        frameUpdate()
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        switch camera.trackingState {
        case .normal:
            trackingNote = nil
        case .notAvailable:
            trackingNote = "AR tracking isn't available right now."
        case .limited(let reason):
            switch reason {
            case .initializing:
                trackingNote = "Starting AR. Move the phone slowly from side to side."
            case .excessiveMotion:
                trackingNote = "Slow down. Move the phone more slowly."
            case .insufficientFeatures:
                trackingNote = "Not enough detail here. Add light, or aim at edges, boxes or tape on the wall."
            case .relocalizing:
                trackingNote = "Finding your place again. Point back at where you were measuring."
            @unknown default:
                trackingNote = "Tracking is limited. Move slowly."
            }
        }
        updateStatus()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        if (error as? ARError)?.code == .cameraUnauthorized {
            finish(.failed(message: FishtapeMeasurePlugin.cameraDeniedMessage, code: "camera_denied"))
        } else {
            finish(.failed(message: "AR stopped: \(error.localizedDescription)", code: "ar_failed"))
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        interrupted = true
        updateStatus()
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        interrupted = false
        updateStatus()
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool {
        true
    }
}

// MARK: - ARCoachingOverlayViewDelegate

extension MeasureViewController: ARCoachingOverlayViewDelegate {
    func coachingOverlayViewWillActivate(_ coachingOverlayView: ARCoachingOverlayView) {
        setMeasuringVisible(false)
    }

    func coachingOverlayViewDidDeactivate(_ coachingOverlayView: ARCoachingOverlayView) {
        setMeasuringVisible(true)
    }

    func coachingOverlayViewDidRequestSessionReset(_ coachingOverlayView: ARCoachingOverlayView) {
        clearPoints()
        startSession(reset: true)
    }
}

// MARK: - Tap anywhere

extension MeasureViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Taps on the buttons and the panel are theirs, not a new point.
        var view = touch.view
        while let current = view {
            if current is UIControl || current === panel || current === controls {
                return false
            }
            view = current.superview
        }
        return !coaching.isActive
    }
}

// MARK: - Overlay views

/// A length label that follows a segment's midpoint on screen.
private final class PillLabel: UILabel {
    enum Style {
        case segment
        case live
    }

    private let insets = UIEdgeInsets(top: 5, left: 12, bottom: 5, right: 12)

    init(style: Style) {
        super.init(frame: .zero)
        font = .monospacedDigitSystemFont(ofSize: style == .segment ? 17 : 15, weight: .bold)
        textColor = style == .segment ? Palette.ink : .white
        backgroundColor = style == .segment ? .white : Palette.scrim
        textAlignment = .center
        layer.masksToBounds = true
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var text: String? {
        didSet {
            if text != oldValue {
                bounds.size = intrinsicContentSize
                layer.cornerRadius = bounds.height / 2
            }
        }
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + insets.left + insets.right, height: size.height + insets.top + insets.bottom)
    }
}

/// The 2D aiming dot at the centre of the screen: dashed while no surface is under it.
private final class CrosshairView: UIView {
    var locked = false {
        didSet {
            if locked != oldValue {
                update()
            }
        }
    }

    private let ring = CAShapeLayer()
    private let centre = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for shape in [ring, centre] {
            shape.strokeColor = UIColor.white.cgColor
            shape.shadowColor = UIColor.black.cgColor
            shape.shadowOpacity = 0.6
            shape.shadowRadius = 2
            shape.shadowOffset = .zero
            layer.addSublayer(shape)
        }
        ring.fillColor = UIColor.clear.cgColor
        ring.lineWidth = 3
        centre.fillColor = UIColor.white.cgColor
        centre.lineWidth = 0
        update()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        let r = min(bounds.width, bounds.height) / 2 - 3
        ring.path = UIBezierPath(arcCenter: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: true).cgPath
        centre.path = UIBezierPath(arcCenter: c, radius: 3.5, startAngle: 0, endAngle: .pi * 2, clockwise: true).cgPath
    }

    private func update() {
        ring.lineDashPattern = locked ? nil : [6, 5]
        alpha = locked ? 1 : 0.7
    }
}
