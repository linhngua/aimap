import SwiftUI

struct RatingStarsView: View {
    let rating: Double
    var maxStars: Int = 5
    var tint: Color = .yellow
    var size: CGFloat = 12

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<maxStars, id: \.self) { index in
                Image(systemName: symbolName(for: index))
                    .font(.system(size: size, weight: .semibold))
                    .foregroundStyle(tint)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rating \(String(format: "%.1f", normalizedRating)) out of \(maxStars)")
    }

    private var normalizedRating: Double {
        max(0, min(Double(maxStars), rating))
    }

    private func symbolName(for index: Int) -> String {
        let value = normalizedRating
        let fullThreshold = Double(index + 1)
        let halfThreshold = Double(index) + 0.5

        if value >= fullThreshold {
            return "star.fill"
        }
        if value >= halfThreshold {
            return "star.leadinghalf.filled"
        }
        return "star"
    }
}

