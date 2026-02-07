import MapKit
import SwiftUI

struct MapScreen: View {
    @StateObject private var viewModel = MapViewModel()

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                MapReader { proxy in
                    Map(position: $viewModel.cameraPosition) {
                        ForEach(viewModel.visiblePlaces) { place in
                            Annotation(place.name, coordinate: place.coordinate) {
                                Button {
                                    viewModel.selectPlace(place)
                                } label: {
                                    Image(systemName: "mappin.circle.fill")
                                        .font(.title2)
                                        .foregroundStyle(.red)
                                        .shadow(radius: 2)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(place.name)
                            }
                        }
                    }
                    .mapControls {
                        MapCompass()
                        MapPitchToggle()
                        MapScaleView()
                    }
                    .onTapGesture { location in
                        if let coordinate = proxy.convert(location, from: .local) {
                            viewModel.handleMapTap(coordinate)
                        }
                    }
                }

                VStack(spacing: 10) {
                    categoryChips
                    statusBanner
                    Spacer()
                    resultsList
                }
                .padding(.top, 8)
            }
            .navigationTitle("AI Map")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        viewModel.isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.refreshNearby()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(viewModel.nearbyResponse == nil)
                    .accessibilityLabel("Refresh")
                }
            }
            .sheet(isPresented: $viewModel.isShowingSettings) {
                NavigationStack {
                    SettingsView(backendBaseURL: $viewModel.backendBaseURLString, radiusMeters: $viewModel.radiusMeters)
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
                    errorMessage: viewModel.placeDetailErrorMessage,
                    onRefresh: { viewModel.refreshPlaceDetail() }
                )
                .presentationDetents([.medium, .large])
            }
        }
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
            } else if let message = viewModel.nearbyErrorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if viewModel.nearbyResponse == nil {
                Text("Tap anywhere on the map to search.")
                    .font(.footnote)
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var resultsList: some View {
        VStack(spacing: 0) {
            if viewModel.nearbyResponse != nil {
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
}

#if DEBUG
struct MapScreen_Previews: PreviewProvider {
    static var previews: some View {
        MapScreen()
    }
}
#endif
