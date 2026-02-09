import SwiftUI

struct SettingsView: View {
    @Binding var radiusMeters: Double
    @Binding var isCachePrimerEnabled: Bool
    @Binding var visibleCategoriesRaw: String

    @State private var slot1: PlaceCategory = .restaurants
    @State private var slot2: PlaceCategory = .bars
    @State private var slot3: PlaceCategory = .attractions

    var body: some View {
        Form {
            Section("AI Backend") {
                LabeledContent("Status", value: "Enabled")
                Text("Backend is embedded in the app.")
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

            Section("Categories") {
                Picker("Chip 1", selection: $slot1) {
                    ForEach(CategoryPreferences.availableCategories) { category in
                        Text(category.title).tag(category)
                    }
                }

                Picker("Chip 2", selection: $slot2) {
                    ForEach(CategoryPreferences.availableCategories) { category in
                        Text(category.title).tag(category)
                    }
                }

                Picker("Chip 3", selection: $slot3) {
                    ForEach(CategoryPreferences.availableCategories) { category in
                        Text(category.title).tag(category)
                    }
                }

                Text("Shown: \(normalizedSlots.map(\.title).joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Cache Primer") {
                Toggle("Prime cache in background", isOn: $isCachePrimerEnabled)
                Text("Warms nearby results around your current location while the app is open.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Notes") {
                Text("Manual refresh bypasses backend cache via header.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            let decoded = CategoryPreferences.normalize(CategoryPreferences.decode(visibleCategoriesRaw))
            applySlots(decoded)
        }
        .onChange(of: slot1) { _, _ in persistSlots() }
        .onChange(of: slot2) { _, _ in persistSlots() }
        .onChange(of: slot3) { _, _ in persistSlots() }
    }

    private var normalizedSlots: [PlaceCategory] {
        CategoryPreferences.normalize([slot1, slot2, slot3])
    }

    private func applySlots(_ categories: [PlaceCategory]) {
        let normalized = CategoryPreferences.normalize(categories)
        slot1 = normalized[safe: 0] ?? CategoryPreferences.defaultSelection[safe: 0] ?? .restaurants
        slot2 = normalized[safe: 1] ?? CategoryPreferences.defaultSelection[safe: 1] ?? .bars
        slot3 = normalized[safe: 2] ?? CategoryPreferences.defaultSelection[safe: 2] ?? .attractions
    }

    private func persistSlots() {
        let normalized = normalizedSlots
        applySlots(normalized)
        visibleCategoriesRaw = CategoryPreferences.encode(normalized)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        guard indices.contains(index) else { return nil }
        return self[index]
    }
}
