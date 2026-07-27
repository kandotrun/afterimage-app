import Foundation

/// Programmatic localization for strings that SwiftUI cannot extract as a
/// static LocalizedStringKey (errors, accessibility labels, Live Activities,
/// and formatted values). Static Text/Button literals stay in the string
/// catalog and are localized by SwiftUI automatically.
enum L10n {
    static func string(_ key: String) -> String {
        Bundle.main.localizedString(forKey: key, value: key, table: "Localizable")
    }

    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(
            format: string(key),
            locale: Locale.autoupdatingCurrent,
            arguments: arguments
        )
    }

    static func apiError(code: String) -> String {
        let key = "api.\(code)"
        let localized = string(key)
        return localized == key ? string("error.api.generic") : localized
    }
}
