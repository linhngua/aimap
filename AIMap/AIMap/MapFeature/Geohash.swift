import Foundation

enum Geohash {
    private static let base32: [Character] = Array("0123456789bcdefghjkmnpqrstuvwxyz")
    private static let bits: [Int] = [16, 8, 4, 2, 1]

    private static let neighbor: [Direction: [String]] = [
        .north: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
        .south: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
        .east: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
        .west: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
    ]

    private static let border: [Direction: [String]] = [
        .north: ["prxz", "bcfguvyz"],
        .south: ["028b", "0145hjnp"],
        .east: ["bcfguvyz", "prxz"],
        .west: ["0145hjnp", "028b"],
    ]

    enum Direction {
        case north
        case south
        case east
        case west
    }

    static func encode(latitude: Double, longitude: Double, precision: Int) -> String {
        guard precision > 0 else { return "" }

        var latRange = (-90.0, 90.0)
        var lngRange = (-180.0, 180.0)

        var hash = ""
        hash.reserveCapacity(precision)

        var isEven = true
        var bit = 0
        var ch = 0

        while hash.count < precision {
            if isEven {
                let mid = (lngRange.0 + lngRange.1) / 2
                if longitude >= mid {
                    ch |= bits[bit]
                    lngRange.0 = mid
                } else {
                    lngRange.1 = mid
                }
            } else {
                let mid = (latRange.0 + latRange.1) / 2
                if latitude >= mid {
                    ch |= bits[bit]
                    latRange.0 = mid
                } else {
                    latRange.1 = mid
                }
            }

            isEven.toggle()
            if bit < 4 {
                bit += 1
            } else {
                hash.append(base32[ch])
                bit = 0
                ch = 0
            }
        }

        return hash
    }

    static func neighbors(of hash: String) -> [String] {
        let n = adjacent(hash, direction: .north)
        let s = adjacent(hash, direction: .south)
        let e = adjacent(hash, direction: .east)
        let w = adjacent(hash, direction: .west)
        let ne = n.isEmpty ? "" : adjacent(n, direction: .east)
        let nw = n.isEmpty ? "" : adjacent(n, direction: .west)
        let se = s.isEmpty ? "" : adjacent(s, direction: .east)
        let sw = s.isEmpty ? "" : adjacent(s, direction: .west)

        return [n, ne, e, se, s, sw, w, nw].filter { !$0.isEmpty }
    }

    static func adjacent(_ hash: String, direction: Direction) -> String {
        guard let last = hash.last else { return "" }
        let type = hash.count % 2
        var parent = String(hash.dropLast())
        let lastString = String(last)

        if border[direction]?[type].contains(lastString) == true, !parent.isEmpty {
            parent = adjacent(parent, direction: direction)
        }

        guard let neighborTable = neighbor[direction]?[type] else { return "" }
        guard let index = neighborTable.firstIndex(of: last) else { return "" }
        let idx = neighborTable.distance(from: neighborTable.startIndex, to: index)
        return parent + String(base32[idx])
    }
}
