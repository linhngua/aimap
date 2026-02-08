import SwiftUI

struct FuturisticMapOverlay: View {
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(
                    colors: [
                        Color.cyan.opacity(0.10),
                        Color.purple.opacity(0.08),
                        Color.black.opacity(0.35)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .blendMode(.overlay)

                RadialGradient(
                    colors: [
                        Color.cyan.opacity(0.22),
                        Color.clear
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: max(proxy.size.width, proxy.size.height) * 0.75
                )
                .blendMode(.colorDodge)

                Canvas { context, size in
                    let spacing: CGFloat = 56
                    var path = Path()

                    for x in stride(from: 0, through: size.width, by: spacing) {
                        path.move(to: CGPoint(x: x, y: 0))
                        path.addLine(to: CGPoint(x: x, y: size.height))
                    }
                    for y in stride(from: 0, through: size.height, by: spacing) {
                        path.move(to: CGPoint(x: 0, y: y))
                        path.addLine(to: CGPoint(x: size.width, y: y))
                    }

                    context.stroke(path, with: .color(Color.cyan.opacity(0.06)), lineWidth: 1)
                }
                .blendMode(.plusLighter)
                .mask(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.0),
                            Color.white.opacity(1.0),
                            Color.white.opacity(0.0)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
            .compositingGroup()
        }
        .allowsHitTesting(false)
    }
}

