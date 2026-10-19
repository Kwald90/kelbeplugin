import Foundation

enum MeasureUnits: String {
    case metric
    case imperial
}

/// Lengths drawn in the AR view, matching fmtLength() in electrical-app/js/lib/units.js:
/// metric shows 450 mm under a metre and 3.25 m from a metre up; imperial shows feet and inches
/// to the 1/16", such as 12' 3 5/8".
enum MeasureFormat {
    static let metresPerInch = 0.0254
    static let denominator = 16

    static func length(_ metres: Double, units: MeasureUnits) -> String {
        guard metres.isFinite else { return "—" }
        switch units {
        case .metric:
            if abs(metres) < 1 {
                return "\(Int((metres * 1000).rounded())) mm"
            }
            return String(format: "%.2f m", metres)
        case .imperial:
            let n = Int((abs(metres) / metresPerInch * Double(denominator)).rounded())
            let perFoot = 12 * denominator
            let feet = n / perFoot
            let rest = n - feet * perFoot
            let sign = metres < 0 && n > 0 ? "-" : ""
            if feet == 0 {
                return sign + inches(rest)
            }
            return rest == 0 ? "\(sign)\(feet)'" : "\(sign)\(feet)' \(inches(rest))"
        }
    }

    /// 58 sixteenths -> 3 5/8"
    static func inches(_ sixteenths: Int) -> String {
        let whole = sixteenths / denominator
        let part = sixteenths % denominator
        if part == 0 {
            return "\(whole)\""
        }
        let divisor = gcd(part, denominator)
        let fraction = "\(part / divisor)/\(denominator / divisor)"
        return whole > 0 ? "\(whole) \(fraction)\"" : "\(fraction)\""
    }

    private static func gcd(_ a: Int, _ b: Int) -> Int {
        b == 0 ? a : gcd(b, a % b)
    }
}
