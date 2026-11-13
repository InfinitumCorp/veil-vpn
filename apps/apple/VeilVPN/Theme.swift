import SwiftUI
import VeilVPNKit

enum VeilColor {
    static let ink = Color(hex: VeilBrand.ink)
    static let muted = Color(hex: VeilBrand.muted)
    static let grey = Color(hex: VeilBrand.grey)
    static let line = Color(hex: VeilBrand.line)
    static let paper = Color(hex: VeilBrand.paper)
    static let warn = Color(hex: VeilBrand.warn)
    static let firmInk = Color(hex: 0x111820)
    static let firmMuted = Color(hex: 0x49545E)
    static let firmLine = Color(hex: 0xE3E6E9)
}

extension Color {
    init(hex: Int) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension Font {
    static func veil(_ size: CGFloat) -> Font { .custom(VeilBrand.fontName, size: size) }
}

struct Wordmark: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text("VEIL")
            Text("</>")
            Text("™")
                .font(.veil(9))
                .baselineOffset(8)
        }
        .font(.veil(15))
        .foregroundStyle(VeilColor.ink)
        .accessibilityLabel("VEIL VPN")
    }
}

struct PowerIcon: View {
    var body: some View {
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
            var path = Path()
            path.addArc(center: CGPoint(x: rect.midX, y: rect.midY + 1), radius: rect.width * 0.36, startAngle: .degrees(220), endAngle: .degrees(140), clockwise: false)
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.midY - 1))
            context.stroke(path, with: .color(VeilColor.ink), lineWidth: 1.4)
        }
        .frame(width: 22, height: 22)
    }
}

struct TabGlyph: View {
    var tab: AppTab
    var body: some View {
        Canvas { context, size in
            let path = TabGlyph.path(tab, in: CGRect(origin: .zero, size: size).insetBy(dx: 1, dy: 1))
            context.stroke(path, with: .foreground, lineWidth: 1.4)
        }
        .frame(width: 22, height: 22)
    }

    static func path(_ tab: AppTab, in rect: CGRect) -> Path {
        var path = Path()
        switch tab {
        case .connect:
            path.addArc(center: CGPoint(x: rect.midX, y: rect.midY + 1), radius: rect.width * 0.34, startAngle: .degrees(220), endAngle: .degrees(140), clockwise: false)
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.midY))
        case .servers:
            path.addEllipse(in: rect.insetBy(dx: 1, dy: 1))
            path.move(to: CGPoint(x: rect.minX + 1, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX - 1, y: rect.midY))
            path.move(to: CGPoint(x: rect.midX, y: rect.minY + 1))
            path.addCurve(to: CGPoint(x: rect.midX, y: rect.maxY - 1), control1: CGPoint(x: rect.maxX - 4, y: rect.midY - 2), control2: CGPoint(x: rect.maxX - 4, y: rect.midY + 2))
            path.move(to: CGPoint(x: rect.midX, y: rect.minY + 1))
            path.addCurve(to: CGPoint(x: rect.midX, y: rect.maxY - 1), control1: CGPoint(x: rect.minX + 4, y: rect.midY - 2), control2: CGPoint(x: rect.minX + 4, y: rect.midY + 2))
        case .earn:
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.move(to: CGPoint(x: rect.minX + 4, y: rect.minY + 7))
            path.addQuadCurve(to: CGPoint(x: rect.maxX - 4, y: rect.minY + 7), control: CGPoint(x: rect.midX, y: rect.minY + 1))
            path.move(to: CGPoint(x: rect.maxX - 4, y: rect.maxY - 7))
            path.addQuadCurve(to: CGPoint(x: rect.minX + 4, y: rect.maxY - 7), control: CGPoint(x: rect.midX, y: rect.maxY - 1))
        case .revenue:
            let bars: [CGFloat] = [0.55, 0.9, 0.4, 0.7]
            let width = rect.width / CGFloat(bars.count * 2 - 1)
            for (index, bar) in bars.enumerated() {
                let x = rect.minX + CGFloat(index) * width * 2
                path.addRect(CGRect(x: x, y: rect.maxY - rect.height * bar, width: width, height: rect.height * bar))
            }
        case .settings:
            path.move(to: CGPoint(x: rect.minX, y: rect.minY + 6))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + 6))
            path.move(to: CGPoint(x: rect.minX, y: rect.maxY - 6))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - 6))
            path.addEllipse(in: CGRect(x: rect.midX + 2, y: rect.minY + 2, width: 8, height: 8))
            path.addEllipse(in: CGRect(x: rect.midX - 10, y: rect.maxY - 10, width: 8, height: 8))
        }
        return path
    }
}

struct PrimaryButton: View {
    var title: String
    var fill: Color = VeilColor.ink
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                Text("↗")
            }
            .font(.veil(13))
            .foregroundStyle(VeilColor.paper)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(fill)
        }
        .buttonStyle(.plain)
    }
}

struct GhostButton: View {
    var title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.veil(13))
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .overlay(Rectangle().stroke(VeilColor.ink, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct VeilSwitch: View {
    var on: Bool
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            ZStack(alignment: on ? .trailing : .leading) {
                Capsule().fill(on ? VeilColor.ink : VeilColor.line)
                Circle().fill(VeilColor.paper).padding(3).frame(width: 22, height: 22)
            }
            .frame(width: 40, height: 22)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(on ? "on" : "off")
    }
}

struct Hairline: View {
    var body: some View { Rectangle().fill(VeilColor.line).frame(height: 1) }
}
