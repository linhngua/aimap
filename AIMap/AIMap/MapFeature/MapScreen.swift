import MapKit
import SwiftUI

struct MapScreen: View {
    @StateObject private var viewModel = MapViewModel()
    @FocusState private var isSearchFocused: Bool
    @State private var locationQuery: String = ""
    @StateObject private var searchCompleter = LocationSearchCompleter()
    @AppStorage(CategoryPreferences.storageKey) private var visibleCategoriesRaw: String = CategoryPreferences.encode(CategoryPreferences.defaultSelection)
    private let mapStyle: LuxuryMapStyle = .premium

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                LuxuryMapView(
                    region: $viewModel.region,
                    style: mapStyle,
                    pins: pins,
                    areaCellIds: viewModel.cachedAreaCellIds,
                    dropPinCoordinate: viewModel.lastTappedCoordinate,
                    onTap: { coordinate in
                        viewModel.handleMapTap(coordinate)
                    },
                    onSelectPin: { placeLocalId in
                        if let place = viewModel.candidatesById[placeLocalId] {
                            viewModel.selectPlace(place)
                        }
                    },
                    onSelectUserLocation: { coordinate in
                        viewModel.handleMapTap(coordinate)
                    }
                )
                .ignoresSafeArea()

                VStack(spacing: 10) {
                    locationSuggestions
                    categoryChips
                    statusBanner
                    Spacer()
                    resultsList
                }
                .padding(.top, 8)
            }
            .navigationBarTitleDisplayMode(.inline)
            .tint(Color(uiColor: mapStyle.accentColor))
            .toolbarBackground(.clear, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationDestination(for: POICategory.self) { category in
                PlacesGridScreen(viewModel: viewModel, category: category, accentColor: Color(uiColor: mapStyle.accentColor))
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        viewModel.isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .principal) {
                    toolbarSearchBar
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.refreshNearby()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(viewModel.lastTappedCoordinate == nil)
                    .accessibilityLabel("Refresh")
                }
            }
            .sheet(isPresented: $viewModel.isShowingSettings) {
                NavigationStack {
                    SettingsView(
                        radiusMeters: $viewModel.radiusMeters,
                        isCachePrimerEnabled: $viewModel.isCachePrimerEnabled,
                        visibleCategoriesRaw: $visibleCategoriesRaw
                    )
                        .navigationTitle("Settings")
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { viewModel.isShowingSettings = false }
                            }
                        }
                }
            }
            .sheet(item: $viewModel.selectedPlace) { place in
                PlaceDetailSheet(
                    place: place,
                    mapItem: viewModel.mapItem(for: place.placeLocalId),
                    detail: viewModel.placeDetail,
                    isLoading: viewModel.isLoadingPlaceDetail,
                    isLoadingAreaFacts: viewModel.isLoadingAreaFacts,
                    errorMessage: viewModel.placeDetailErrorMessage,
                    userLocation: viewModel.userLocation ?? viewModel.lastTappedCoordinate,
                    onRefresh: { viewModel.refreshPlaceDetail() },
                    onSelectNearby: { placeLocalId in
                        if let nearby = viewModel.candidatesById[placeLocalId] {
                            viewModel.selectPlace(nearby)
                        }
                    }
                )
                .presentationDetents([.medium, .large])
            }
        }
        .task {
            viewModel.centerOnUserLocationIfNeeded()
            viewModel.ensureSelectedCategory(in: visibleCategories)
        }
        .onChange(of: visibleCategoriesRaw) { _, _ in
            viewModel.ensureSelectedCategory(in: visibleCategories)
        }
        .onChange(of: viewModel.nearbyPayload) { _, _ in
            viewModel.ensureSelectedCategory(in: visibleCategories)
        }
    }

    private var locationSearchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Search location", text: $locationQuery)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($isSearchFocused)
                .onChange(of: locationQuery) { _, newValue in
                    searchCompleter.update(query: newValue, region: viewModel.region)
                }
                .onSubmit {
                    viewModel.searchForLocation(locationQuery)
                    searchCompleter.clear()
                    isSearchFocused = false
                }

            if viewModel.isSearchingLocation {
                ProgressView()
            } else if !locationQuery.isEmpty {
                Button {
                    locationQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(uiColor: mapStyle.accentColor).opacity(0.35), lineWidth: 1)
        )
        .padding(.horizontal)
    }

    private var toolbarSearchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Search location", text: $locationQuery)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($isSearchFocused)
                .onChange(of: locationQuery) { _, newValue in
                    searchCompleter.update(query: newValue, region: viewModel.region)
                }
                .onSubmit {
                    viewModel.searchForLocation(locationQuery)
                    searchCompleter.clear()
                    isSearchFocused = false
                }

            if viewModel.isSearchingLocation {
                ProgressView()
            } else if !locationQuery.isEmpty {
                Button {
                    locationQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(uiColor: mapStyle.accentColor).opacity(0.22), lineWidth: 1)
        )
        .frame(maxWidth: 520)
    }

    private var locationSuggestions: some View {
        Group {
            let trimmedQuery = locationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            let shouldSuggest = trimmedQuery.count >= 2
                && (isSearchFocused || searchCompleter.isLoading || !searchCompleter.results.isEmpty)
            if shouldSuggest {
                VStack(spacing: 0) {
                    if searchCompleter.isLoading {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Searching…")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                    } else if searchCompleter.results.isEmpty {
                        HStack {
                            Text("No suggestions")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                    } else {
                        ForEach(Array(searchCompleter.results.prefix(6).enumerated()), id: \.offset) { index, completion in
                            Button {
                                viewModel.searchForCompletion(completion)
                                locationQuery = completion.title
                                searchCompleter.clear()
                                isSearchFocused = false
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(completion.title)
                                        .font(.subheadline)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    if !completion.subtitle.isEmpty {
                                        Text(completion.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 10)
                                .padding(.horizontal, 12)
                            }
                            .buttonStyle(.plain)

                            if index < min(searchCompleter.results.count, 6) - 1 {
                                Divider()
                                    .opacity(0.12)
                            }
                        }
                    }
                }
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color(uiColor: mapStyle.accentColor).opacity(0.28), lineWidth: 1)
                )
                .padding(.horizontal)
            }
        }
    }

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(visibleCategories, id: \.self) { category in
                    let count = viewModel.categoryCounts[category] ?? 0
                    CategoryChip(
                        category: category,
                        count: count,
                        isSelected: viewModel.selectedCategory == category,
                        accent: Color(uiColor: mapStyle.accentColor),
                        onSelect: { viewModel.selectCategory(category) }
                    )
                }
            }
            .padding(.horizontal)
        }
    }

    private var statusBanner: some View {
        Group {
            if viewModel.isLoadingNearby {
                HStack {
                    ProgressView()
                    Text("Finding nearby places…")
                }
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let message = viewModel.locationSearchErrorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let message = viewModel.nearbyErrorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if viewModel.nearbyPayload == nil {
                Text("Tap anywhere on the map to search.")
                    .font(.footnote)
                    .padding(10)
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if viewModel.nearbyAccuracy == .approx {
                Text("Showing nearby cached results (approx).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var resultsList: some View {
        Group {
            if viewModel.nearbyPayload != nil {
                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: 10) {
                        ForEach(viewModel.listItemsForSelectedCategory) { item in
                            let place = item.place
                            Button {
                                viewModel.selectPlace(place)
                            } label: {
                                PlaceListRow(
                                    place: place,
                                    score: item.score,
                                    why: item.why,
                                    accent: Color(uiColor: mapStyle.accentColor)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(12)
                }
                .frame(maxHeight: 340)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.ultraThinMaterial)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(
                            LinearGradient(
                                colors: [
                                    Color(uiColor: mapStyle.accentColor).opacity(0.28),
                                    Color.white.opacity(0.10),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                )
                .shadow(color: Color.black.opacity(0.22), radius: 18, x: 0, y: 10)
                .padding(.horizontal)
                .padding(.bottom, 10)
            }
        }
    }

    private var visibleCategories: [POICategory] {
        CategoryPreferences.normalize(CategoryPreferences.decode(visibleCategoriesRaw))
    }

    private var pins: [LuxuryMapPin] {
        let baseOpacity: CGFloat = viewModel.nearbyAccuracy == .approx ? 0.55 : 1.0
        return viewModel.visiblePlaces.map { place in
            LuxuryMapPin(
                id: place.placeLocalId,
                title: place.name,
                coordinate: place.coordinate,
                opacity: baseOpacity,
                isHighlighted: viewModel.selectedPlace?.placeLocalId == place.placeLocalId
            )
        }
    }
}

private struct PlaceListRow: View {
    let place: CandidatePlace
    let score: Double
    let why: String
    let accent: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(place.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                if !place.addressShort.isEmpty {
                    Text(place.addressShort)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                let trimmedWhy = why.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedWhy.isEmpty {
                    Text(trimmedWhy)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            ratingColumn
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.thinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(accent.opacity(0.18), lineWidth: 1)
        )
    }

    private var ratingColumn: some View {
        let trimmedWhy = why.trimmingCharacters(in: .whitespacesAndNewlines)
        let ratingValue: Double? = {
            if let rating = place.rating { return max(0, min(5, rating)) }
            guard !trimmedWhy.isEmpty else { return nil }
            return max(0, min(5, score * 5))
        }()

        return VStack(alignment: .trailing, spacing: 4) {
            if let ratingValue {
                RatingStarsView(rating: ratingValue, tint: accent, size: 11)
                Text(String(format: "%.1f", ratingValue))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minWidth: 62, alignment: .trailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            ratingValue.map { "Rating \(String(format: "%.1f", $0)) out of 5" } ?? "No rating"
        )
    }
}

private struct CategoryChip: View {
    let category: POICategory
    let count: Int
    let isSelected: Bool
    let accent: Color
    let onSelect: () -> Void

    var body: some View {
        NavigationLink(value: category) {
            HStack(spacing: 8) {
                Image(systemName: category.systemImage)
                    .font(.subheadline)
                    .foregroundStyle(accent)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(accent.opacity(isSelected ? 0.22 : 0.14))
                    )

                Text("\(category.title) (\(count))")
                    .font(.subheadline)
                    .foregroundStyle(.primary)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(.ultraThinMaterial)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .fill(isSelected ? accent.opacity(0.12) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(accent.opacity(isSelected ? 0.30 : 0.14), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .simultaneousGesture(TapGesture().onEnded(onSelect))
        .accessibilityLabel("Open \(category.title) grid")
    }
}

#if DEBUG
struct MapScreen_Previews: PreviewProvider {
    static var previews: some View {
        MapScreen()
    }
}
#endif

@MainActor
private final class LocationSearchCompleter: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {
    @Published var results: [MKLocalSearchCompletion] = []
    @Published var isLoading: Bool = false
    @Published private(set) var lastQuery: String = ""

    private let completer: MKLocalSearchCompleter = MKLocalSearchCompleter()
    private var updateTask: Task<Void, Never>?

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
    }

    var shouldShowSuggestions: Bool {
        lastQuery.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    func update(query: String, region: MKCoordinateRegion) {
        lastQuery = query
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        updateTask?.cancel()

        guard trimmed.count >= 2 else {
            clear()
            return
        }

        isLoading = true
        updateTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard let self else { return }
            guard !Task.isCancelled else { return }
            self.completer.region = region
            self.completer.queryFragment = trimmed
        }
    }

    func clear() {
        updateTask?.cancel()
        isLoading = false
        results = []
        completer.queryFragment = ""
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let nextResults = Array(completer.results.prefix(10))
        Task { @MainActor in
            isLoading = false
            results = nextResults
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        _ = error
        Task { @MainActor in
            isLoading = false
            results = []
        }
    }
}
