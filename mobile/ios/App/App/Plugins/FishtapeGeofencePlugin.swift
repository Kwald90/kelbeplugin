import Capacitor
import CoreLocation
import Foundation

/// FishtapeGeofence: notices arrivals at and departures from job sites while someone is clocked in,
/// with the app in the background or closed, without draining the battery. It uses region monitoring
/// (one circle per job site, at most 18) and significant location changes, both of which iOS runs at
/// low power and which relaunch the app in the background when they fire. It never runs continuous
/// GPS and never runs without an open shift. Contract (electrical-app/js/lib/location.js):
///
///     start({ shiftId, regions: [{ id, lat, lng, radiusM }] }) -> { tracking, authorization }
///     stop() -> {}
///     events() -> { events: [{ at, type: "enter"|"exit"|"significant", siteId?, lat?, lng?, accuracyM? }] }   (drained)
///     status() -> { tracking, shiftId?, authorization }
///
/// Rules (docs/compliance/privacy.md, "Location while clocked in"):
/// - start() refuses without a shift id: the web app calls it only for an open time entry.
/// - stop() is called at clock-out (and whenever the web app finds no open shift). It clears the
///   regions, stops significant changes and drops any events not yet read.
/// - A shift older than 18 hours stops itself, so a forgotten clock-out can't track overnight.
@objc(FishtapeGeofencePlugin)
public class FishtapeGeofencePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapeGeofencePlugin"
    public let jsName = "FishtapeGeofence"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "events", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        FishtapeLocationMonitor.shared.onEvent = { [weak self] event in
            self?.notifyListeners("geofence", data: event)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let shiftId = call.getString("shiftId"), !shiftId.isEmpty else {
            call.reject("No open shift: location is only watched while you are clocked in.", "no_shift")
            return
        }
        let raw = call.getArray("regions", JSObject.self) ?? []
        let regions: [FishtapeLocationMonitor.Site] = raw.compactMap { r in
            guard let id = r["id"] as? String, let lat = (r["lat"] as? NSNumber)?.doubleValue, let lng = (r["lng"] as? NSNumber)?.doubleValue else { return nil }
            let radius = (r["radiusM"] as? NSNumber)?.doubleValue ?? 150
            return FishtapeLocationMonitor.Site(id: id, lat: lat, lng: lng, radiusM: radius)
        }
        DispatchQueue.main.async {
            FishtapeLocationMonitor.shared.start(shiftId: shiftId, sites: regions)
            call.resolve(["tracking": true, "authorization": FishtapeLocationMonitor.shared.authorization])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            FishtapeLocationMonitor.shared.stop()
            call.resolve()
        }
    }

    @objc func events(_ call: CAPPluginCall) {
        call.resolve(["events": FishtapeLocationMonitor.shared.drain()])
    }

    @objc func status(_ call: CAPPluginCall) {
        let m = FishtapeLocationMonitor.shared
        var out: [String: Any] = ["tracking": m.shiftId != nil, "authorization": m.authorization]
        if let id = m.shiftId { out["shiftId"] = id }
        call.resolve(out)
    }
}

/// Owns the CLLocationManager. Created at launch (AppDelegate), because iOS relaunches the app in the
/// background for region and significant-change events before any web view or plugin exists; events
/// are kept in UserDefaults until the web app reads them.
final class FishtapeLocationMonitor: NSObject, CLLocationManagerDelegate {
    struct Site { let id: String; let lat: Double; let lng: Double; let radiusM: Double }

    static let shared = FishtapeLocationMonitor()
    private let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private static let shiftKey = "ft.geofence.shift"
    private static let startedKey = "ft.geofence.startedAt"
    private static let eventsKey = "ft.geofence.events"
    private static let regionPrefix = "ft-site-"
    private static let maxEvents = 500
    private static let maxShiftSeconds: TimeInterval = 18 * 3600
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    var onEvent: (([String: Any]) -> Void)?

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = true
    }

    var shiftId: String? { defaults.string(forKey: Self.shiftKey) }

    var authorization: String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    /// Called from AppDelegate on every launch: stop anything left over from a shift that is too old.
    func resume() {
        guard shiftId != nil else { return }
        let started = defaults.double(forKey: Self.startedKey)
        if started > 0, Date().timeIntervalSince1970 - started > Self.maxShiftSeconds { stop() }
    }

    func start(shiftId: String, sites: [Site]) {
        let isNewShift = self.shiftId != shiftId
        if isNewShift {
            defaults.removeObject(forKey: Self.eventsKey)
            defaults.set(Date().timeIntervalSince1970, forKey: Self.startedKey)
        }
        defaults.set(shiftId, forKey: Self.shiftKey)
        // Region monitoring needs "Always". iOS asks "While Using" first, then offers the upgrade.
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        for region in manager.monitoredRegions where region.identifier.hasPrefix(Self.regionPrefix) {
            manager.stopMonitoring(for: region)
        }
        if CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) {
            for site in sites.prefix(18) {
                let radius = min(max(site.radiusM, 30), manager.maximumRegionMonitoringDistance)
                let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: site.lat, longitude: site.lng), radius: radius, identifier: Self.regionPrefix + site.id)
                region.notifyOnEntry = true
                region.notifyOnExit = true
                manager.startMonitoring(for: region)
            }
        }
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }
    }

    func stop() {
        for region in manager.monitoredRegions where region.identifier.hasPrefix(Self.regionPrefix) {
            manager.stopMonitoring(for: region)
        }
        manager.stopMonitoringSignificantLocationChanges()
        defaults.removeObject(forKey: Self.shiftKey)
        defaults.removeObject(forKey: Self.startedKey)
        defaults.removeObject(forKey: Self.eventsKey)
    }

    func drain() -> [[String: Any]] {
        let list = (defaults.array(forKey: Self.eventsKey) as? [[String: Any]]) ?? []
        defaults.removeObject(forKey: Self.eventsKey)
        return list
    }

    private func record(_ type: String, siteId: String?, location: CLLocation?) {
        guard shiftId != nil else { return } // never off the clock
        resume()
        guard shiftId != nil else { return }
        var event: [String: Any] = ["at": Self.iso.string(from: location?.timestamp ?? Date()), "type": type]
        if let siteId { event["siteId"] = siteId }
        if let loc = location, loc.horizontalAccuracy >= 0 {
            event["lat"] = (loc.coordinate.latitude * 1e6).rounded() / 1e6
            event["lng"] = (loc.coordinate.longitude * 1e6).rounded() / 1e6
            event["accuracyM"] = Int(loc.horizontalAccuracy.rounded())
        }
        var list = (defaults.array(forKey: Self.eventsKey) as? [[String: Any]]) ?? []
        list.append(event)
        if list.count > Self.maxEvents { list.removeFirst(list.count - Self.maxEvents) }
        defaults.set(list, forKey: Self.eventsKey)
        onEvent?(event)
    }

    private func siteId(_ region: CLRegion) -> String? {
        region.identifier.hasPrefix(Self.regionPrefix) ? String(region.identifier.dropFirst(Self.regionPrefix.count)) : nil
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard let id = siteId(region) else { return }
        record("enter", siteId: id, location: manager.location)
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard let id = siteId(region) else { return }
        record("exit", siteId: id, location: manager.location)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        record("significant", siteId: nil, location: last)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // "While Using" was just granted for an open shift: ask for the background upgrade once.
        if shiftId != nil, manager.authorizationStatus == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {}
}
