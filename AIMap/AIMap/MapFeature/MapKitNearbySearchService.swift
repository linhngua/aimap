import CoreLocation
import Foundation
import MapKit

enum MapKitNearbySearchError: Error {
    case emptyResults
}

struct MapKitNearbySearchService {
    struct Configuration {
        var radiusMeters: Double = 800
        var maxCandidates: Int = 40
        var addressMaxCharacters: Int = 80
        var categoryMax: Int = 6
    }

    var configuration: Configuration = .init()

    func fetchCandidates(near coordinate: CLLocationCoordinate2D) async throws -> [CandidatePlace] {
        let pairs = try await fetchCandidatesAndMapItems(near: coordinate)
        return pairs.map(\.0)
    }

    func fetchCandidatesAndMapItems(near coordinate: CLLocationCoordinate2D) async throws -> [(CandidatePlace, MKMapItem)] {
        if #available(iOS 17.0, *) {
            do {
                let request = MKLocalPointsOfInterestRequest(center: coordinate, radius: configuration.radiusMeters)
                let search = MKLocalSearch(request: request)
                let response = try await search.start()
                let mapItems = response.mapItems
                return mapItemsToCandidatesAndItems(mapItems)
            } catch {
                return try await fetchWithLocalSearchAndItems(coordinate)
            }
        } else {
            return try await fetchWithLocalSearchAndItems(coordinate)
        }
    }

    private func fetchWithLocalSearch(_ coordinate: CLLocationCoordinate2D) async throws -> [CandidatePlace] {
        let pairs = try await fetchWithLocalSearchAndItems(coordinate)
        return pairs.map(\.0)
    }

    private func fetchWithLocalSearchAndItems(_ coordinate: CLLocationCoordinate2D) async throws -> [(CandidatePlace, MKMapItem)] {
        let request = MKLocalSearch.Request()
        request.region = MKCoordinateRegion(
            center: coordinate,
            latitudinalMeters: configuration.radiusMeters * 2,
            longitudinalMeters: configuration.radiusMeters * 2
        )
        request.resultTypes = [.pointOfInterest]
        let search = MKLocalSearch(request: request)
        let response = try await search.start()
        return mapItemsToCandidatesAndItems(response.mapItems)
    }

    private func mapItemsToCandidates(_ mapItems: [MKMapItem]) -> [CandidatePlace] {
        mapItemsToCandidatesAndItems(mapItems).map(\.0)
    }

    private func mapItemsToCandidatesAndItems(_ mapItems: [MKMapItem]) -> [(CandidatePlace, MKMapItem)] {
        let limited = Array(mapItems.prefix(configuration.maxCandidates))
        var results: [(CandidatePlace, MKMapItem)] = []
        results.reserveCapacity(limited.count)

        for item in limited {
            guard let candidate = mapItemToCandidate(item) else { continue }
            results.append((candidate, item))
        }

        return results
    }

    private func mapItemToCandidate(_ item: MKMapItem) -> CandidatePlace? {
        guard let name = item.name else { return nil }
        let coordinate = item.placemark.coordinate
        let lat = coordinate.latitude
        let lng = coordinate.longitude

        let address = trimmedAddress(from: item.placemark)
        let rawCategories = extractRawCategories(from: item)

        let placeLocalId: String
        if #available(iOS 18.0, *), let identifier = item.identifier?.rawValue, !identifier.isEmpty {
            placeLocalId = identifier
        } else {
            placeLocalId = CandidatePlace.fallbackLocalId(name: name, lat: lat, lng: lng)
        }

        return CandidatePlace(
            placeLocalId: placeLocalId,
            name: name,
            lat: lat,
            lng: lng,
            addressShort: address,
            rawCategories: rawCategories,
            url: item.url?.absoluteString,
            phone: item.phoneNumber,
            rating: nil,
            ratingCount: nil,
            priceLevel: nil,
            openNow: nil
        )
    }

    private func trimmedAddress(from placemark: MKPlacemark) -> String {
        var parts: [String] = []
        if let subThoroughfare = placemark.subThoroughfare { parts.append(subThoroughfare) }
        if let thoroughfare = placemark.thoroughfare { parts.append(thoroughfare) }
        if let locality = placemark.locality { parts.append(locality) }
        if let administrativeArea = placemark.administrativeArea { parts.append(administrativeArea) }

        let joined = parts.joined(separator: " ")
        if joined.count <= configuration.addressMaxCharacters { return joined }
        return String(joined.prefix(configuration.addressMaxCharacters))
    }

    private func extractRawCategories(from item: MKMapItem) -> [String] {
        if let poi = item.pointOfInterestCategory {
            return [poi.rawValue]
        }
        return []
    }
}
