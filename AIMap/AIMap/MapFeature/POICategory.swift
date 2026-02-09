import Foundation

enum POICategory: String, CaseIterable, Codable, Hashable, Identifiable {
    case restaurants = "restaurants"
    case cafesCoffee = "cafes_coffee"
    case barsPubs = "bars_pubs"
    case nightlifeClubs = "nightlife_clubs"
    case bakeriesDesserts = "bakeries_desserts"
    case landmarksMonuments = "landmarks_monuments"
    case museumsGalleries = "museums_galleries"
    case attractions = "attractions"
    case scenicSpotsViews = "scenic_spots_views"
    case religiousSpiritual = "religious_spiritual"
    case localShopsBoutiques = "local_shops_boutiques"
    case marketsFoodHalls = "markets_food_halls"
    case mallsDepartmentStores = "malls_department_stores"
    case parksNature = "parks_nature"
    case wellnessSpa = "wellness_spa"
    case fitnessSports = "fitness_sports"
    case hotelsLodging = "hotels_lodging"
    case eventsVenues = "events_venues"
    case transportHubs = "transport_hubs"
    case essentials = "essentials"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .restaurants: return "Restaurants"
        case .cafesCoffee: return "Cafes & Coffee"
        case .barsPubs: return "Bars & Pubs"
        case .nightlifeClubs: return "Nightlife & Clubs"
        case .bakeriesDesserts: return "Bakeries & Desserts"
        case .landmarksMonuments: return "Landmarks & Monuments"
        case .museumsGalleries: return "Museums & Galleries"
        case .attractions: return "Attractions"
        case .scenicSpotsViews: return "Scenic Spots & Views"
        case .religiousSpiritual: return "Religious & Spiritual Sites"
        case .localShopsBoutiques: return "Local Shops & Boutiques"
        case .marketsFoodHalls: return "Markets & Food Halls"
        case .mallsDepartmentStores: return "Malls & Department Stores"
        case .parksNature: return "Parks & Nature"
        case .wellnessSpa: return "Wellness & Spa"
        case .fitnessSports: return "Fitness & Sports"
        case .hotelsLodging: return "Hotels & Lodging"
        case .eventsVenues: return "Events & Venues"
        case .transportHubs: return "Transport Hubs"
        case .essentials: return "Essentials (pharmacy, ATM, supermarket)"
        }
    }

    var systemImage: String {
        switch self {
        case .restaurants: return "fork.knife"
        case .cafesCoffee: return "cup.and.saucer.fill"
        case .barsPubs: return "wineglass"
        case .nightlifeClubs: return "music.note.list"
        case .bakeriesDesserts: return "birthday.cake"
        case .landmarksMonuments: return "building.columns"
        case .museumsGalleries: return "photo.on.rectangle"
        case .attractions: return "sparkles"
        case .scenicSpotsViews: return "binoculars"
        case .religiousSpiritual: return "cross.fill"
        case .localShopsBoutiques: return "bag"
        case .marketsFoodHalls: return "cart"
        case .mallsDepartmentStores: return "building.2"
        case .parksNature: return "leaf"
        case .wellnessSpa: return "leaf.circle"
        case .fitnessSports: return "figure.run"
        case .hotelsLodging: return "bed.double"
        case .eventsVenues: return "ticket"
        case .transportHubs: return "tram"
        case .essentials: return "cross.case"
        }
    }

    static func classify(_ place: CandidatePlace) -> POICategory {
        let categories = place.rawCategories.joined(separator: " ").lowercased()
        let name = place.name.lowercased()
        let address = place.addressShort.lowercased()
        let haystack = "\(categories) \(name) \(address)"

        func has(_ terms: [String]) -> Bool { terms.contains { haystack.contains($0) } }

        // Essentials
        if has(["pharmacy", "atm", "bank", "gasstation", "hospital", "supermarket", "grocery"]) { return .essentials }

        // Transport hubs
        if has(["airport", "publictransport", "parking", "marina", "carrental", "transit", "station"]) {
            return .transportHubs
        }

        // Lodging
        if has(["hotel", "campground", "rvpark", "lodging", "inn", "resort"]) { return .hotelsLodging }

        // Wellness / fitness
        if has(["spa", "beauty"]) { return .wellnessSpa }
        if has(["fitnesscenter", "gym", "stadium", "golf", "tennis", "swimming", "skiing", "soccer", "basketball", "baseball", "bowling", "rockclimbing", "hiking", "skatepark"]) {
            return .fitnessSports
        }

        // Events & venues
        if has(["theater", "movietheater", "musicvenue", "conventioncenter", "fairground", "arena", "venue"]) {
            return .eventsVenues
        }

        // Nature / scenic
        if has(["nationalpark", "park", "beach", "zoo", "aquarium"]) { return .parksNature }
        if has(["scenic", "lookout", "view", "vista", "overlook"]) { return .scenicSpotsViews }

        // Religious / spiritual (MapKit has no category; rely on name)
        if has(["church", "temple", "mosque", "synagogue", "cathedral", "shrine", "chapel"]) { return .religiousSpiritual }

        // Museums / landmarks / attractions
        if has(["museum", "gallery"]) { return .museumsGalleries }
        if has(["landmark", "nationalmonument", "monument", "castle", "fortress"]) { return .landmarksMonuments }
        if has(["amusementpark", "planetarium"]) { return .attractions }

        // Food & drink
        if has(["bakery", "dessert", "icecream"]) { return .bakeriesDesserts }
        if has(["cafe", "coffee"]) { return .cafesCoffee }
        if has(["nightlife", "club", "lounge"]) { return .nightlifeClubs }
        if has(["brewery", "winery", "distillery", "pub", "bar"]) { return .barsPubs }
        if has(["restaurant", "diner", "bistro", "grill", "pizza", "sushi"]) { return .restaurants }

        // Shopping
        if has(["foodmarket", "market", "food hall", "foodhall", "farmers"]) { return .marketsFoodHalls }
        if has(["mall", "department"]) { return .mallsDepartmentStores }
        if has(["boutique", "shop", "store"]) { return .localShopsBoutiques }

        // Default
        return .attractions
    }
}
