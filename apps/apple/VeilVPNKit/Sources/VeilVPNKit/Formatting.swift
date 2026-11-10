import Foundation

/// Number formatting that matches `toLocaleString('en-US')` in the shared interface.
public enum VeilFormat {
    public static func grouped(_ value: Int) -> String {
        let sign = value < 0 ? "-" : ""
        let digits = String(abs(value))
        var out = ""
        for (index, ch) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return sign + out
    }

    public static func fixed(_ value: Double, digits: Int) -> String {
        let factor = pow(10, Double(digits))
        let rounded = (value * factor).rounded() / factor
        let sign = rounded < 0 ? "-" : ""
        let absValue = abs(rounded)
        let whole = Int(absValue)
        if digits == 0 { return sign + grouped(whole) }
        let frac = Int((absValue * factor).rounded()) - whole * Int(factor)
        let fracText = String(format: "%0*d", digits, max(0, frac))
        return sign + grouped(whole) + "." + fracText
    }

    public static func usd(_ value: Double) -> String {
        let n = value.isFinite ? value : 0
        let digits: Int
        if n > 0 && n < 1 { digits = 3 }
        else if n < 100 { digits = 2 }
        else { digits = 0 }
        return "$" + fixed(n, digits: digits)
    }

    public static func hms(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return [s / 3600, (s % 3600) / 60, s % 60]
            .map { String(format: "%02d", $0) }
            .joined(separator: ":")
    }

    public static func megabytes(bytes: Double) -> String {
        fixed(bytes / 1_000_000, digits: 1) + " MB"
    }

    /// JavaScript `Number.toPrecision(2)` on a percentage weight, including the trailing `%`.
    public static func weightPercent(_ weight: Double) -> String {
        if weight == 0 { return "0%" }
        if weight < 1e-4 { return "<0.01%" }
        return precision(weight * 100, digits: 2) + "%"
    }

    public static func plural(_ n: Double, _ word: String) -> String {
        let rounded = Int(n.rounded())
        return "\(grouped(rounded)) \(word)\(rounded == 1 ? "" : "s")"
    }

    static func precision(_ value: Double, digits: Int) -> String {
        if value == 0 { return "0" }
        let absValue = abs(value)
        let exp = floorLog10(absValue)
        let scale = pow(10, Double(digits - 1 - exp))
        let rounded = (absValue * scale).rounded() / scale
        let fractionDigits = max(0, digits - 1 - floorLog10(rounded))
        let text = fixed(value < 0 ? -rounded : rounded, digits: fractionDigits)
        guard text.contains(".") else { return text }
        var trimmed = text
        while trimmed.last == "0" { trimmed.removeLast() }
        if trimmed.last == "." { trimmed.removeLast() }
        return trimmed
    }

    private static func floorLog10(_ value: Double) -> Int {
        var scaled = value
        var exp = 0
        if scaled >= 10 {
            while scaled >= 10 { scaled /= 10; exp += 1 }
        } else if scaled > 0 && scaled < 1 {
            while scaled < 1 { scaled *= 10; exp -= 1 }
        }
        return exp
    }
}

public enum SolanaAddress {
    public static func isValid(_ address: String) -> Bool {
        let count = address.count
        guard (32...44).contains(count) else { return false }
        let alphabet = Set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        return address.allSatisfy { alphabet.contains($0) }
    }
}

public func countryCode(from flag: String) -> String {
    var out = ""
    for scalar in flag.unicodeScalars {
        let value = Int(scalar.value) - 0x1F1E6
        if (0..<26).contains(value), let unicode = UnicodeScalar(65 + value) {
            out.append(Character(unicode))
        }
    }
    return out
}
