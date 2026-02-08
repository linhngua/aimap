import SwiftUI

struct SettingsView: View {
    @Binding var backendBaseURL: String
    @Binding var radiusMeters: Double

    var body: some View {
        Form {
            Section("Backend") {
                TextField("https://map.petetranfab.com", text: $backendBaseURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                Text("Stored on-device. Required for LLM grouping.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Search") {
                Slider(value: $radiusMeters, in: 200...1500, step: 50) {
                    Text("Radius")
                } minimumValueLabel: {
                    Text("200m")
                        .font(.caption)
                } maximumValueLabel: {
                    Text("1500m")
                        .font(.caption)
                }

                Text("Radius: \(Int(radiusMeters)) meters")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Notes") {
                Text("Manual refresh bypasses backend cache via header.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
