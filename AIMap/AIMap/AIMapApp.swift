//
//  AIMapApp.swift
//  AIMap
//
//  Created by Xuan linh Tran on 8/2/26.
//

import SwiftUI

@main
struct AIMapApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onAppear {
                    // Prompt for location use early for MapKit POI results.
                    // The Map screen also works without granting this.
                }
        }
    }
}
