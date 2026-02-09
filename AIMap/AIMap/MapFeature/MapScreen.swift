import MapKit
import SwiftUI

struct MapScreen: View {
    @StateObject private var viewModel = MapViewModel()
    @FocusState private var isSearchFocused: Bool
    @State private var locationQuery: String = ""
    private let mapStyle: LuxuryMapStyle = .premium

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                LuxuryMapView(
                    region: $viewModel.region,
                    style: mapStyle,
                    pins: pins,
                    dropPinCoordinate: viewModel.lastTappedCoordinate,
                    onTap: { coordinate in
                        viewModel.handleMapTap(coordinate)
                    },
                    onSelectPin: { placeLocalId in
                        if let place = viewModel.candidatesById[placeLocalId] {
                            viewModel.selectPlace(place)
                        }
                    }
                )

                VStack(spacing: 10) {
                    locationSearchBar
                    categoryChips
                    statusBanner
                    Spacer()
                    resultsList
                }
                .padding(.top, 8)
            }
            .navigationBarTitleDisplayMode(.inline)
            .tint(Color(uiColor: mapStyle.accentColor))
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        viewModel.isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text("AI MAP")
                        .font(.caption)
                        .fontWeight(.regular)
                        .foregroundStyle(Color(uiColor: mapStyle.accentColor))
                        .accessibilityAddTraits(.isHeader)
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
                    SettingsView(radiusMeters: $viewModel.radiusMeters)
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
                    detail: viewModel.placeDetail,
                    isLoading: viewModel.isLoadingPlaceDetail,
                    isLoadingAreaFacts: viewModel.isLoadingAreaFacts,
                    errorMessage: viewModel.placeDetailErrorMessage,
                    userLocation: viewModel.userLocation,
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
                .onSubmit {
                    viewModel.searchForLocation(locationQuery)
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
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(uiColor: mapStyle.accentColor).opacity(0.35), lineWidth: 1)
        )
        .padding(.horizontal)
    }

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(PlaceCategory.allCases, id: \.self) { category in
                    let count = viewModel.categoryCounts[category] ?? 0
                    Button {
                        viewModel.selectCategory(category)
                    } label: {
                        Label("\(category.title) (\(count))", systemImage: category.systemImage)
                            .font(.subheadline)
                            .padding(.vertical, 8)
                            .padding(.horizontal, 12)
                            .background(
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(viewModel.selectedCategory == category ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground))
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(count == 0)
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
                .background(.thinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let message = viewModel.locationSearchErrorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let message = viewModel.nearbyErrorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if viewModel.nearbyPayload == nil {
                Text("Tap anywhere on the map to search.")
                    .font(.footnote)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if viewModel.nearbyAccuracy == .approx {
                Text("Showing nearby cached results (approx).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var resultsList: some View {
        VStack(spacing: 0) {
            if viewModel.nearbyPayload != nil {
                List {
                    ForEach(viewModel.rankedItemsForSelectedCategory) { ranked in
                        if let place = viewModel.candidatesById[ranked.placeLocalId] {
                            Button {
                                viewModel.selectPlace(place)
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(place.name)
                                            .font(.headline)
                                        Spacer()
                                        Text(String(format: "%.2f", ranked.score))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(place.addressShort)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Text(ranked.why)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .frame(maxHeight: 320)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)
                .padding(.bottom, 10)
            }
        }
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

#if DEBUG
struct MapScreen_Previews: PreviewProvider {
    static var previews: some View {
        MapScreen()
    }
}
#endif
