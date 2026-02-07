import SwiftUI

struct PlaceDetailSheet: View {
    let place: CandidatePlace
    let detail: PlaceDetailResponse?
    let isLoading: Bool
    let errorMessage: String?
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(place.name)
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text(place.addressShort)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Button {
                    onRefresh()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh place")
            }

            if isLoading {
                HStack {
                    ProgressView()
                    Text("Generating details…")
                }
                .padding(.vertical, 8)
            } else if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if let detail {
                Text(detail.summary)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                GroupBox("Highlights") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(detail.highlights, id: \.self) { item in
                            Text("• \(item)")
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if !detail.cautions.isEmpty {
                    GroupBox("Cautions") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(detail.cautions, id: \.self) { item in
                                Text("• \(item)")
                                    .font(.subheadline)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if !detail.tips.isEmpty {
                    GroupBox("Tips") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(detail.tips, id: \.self) { item in
                                Text("• \(item)")
                                    .font(.subheadline)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                Text(detail.disclosure)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            } else {
                Text("No details yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding()
    }
}

