import Foundation

/// Parses a completed recognition result only. Both activation phrases select the
/// same dictation mode; this parser never implies submitting or sending text.
enum DictationActivation {
    // Рокки and Rocky are spelling variants of the spoken name, not fuzzy matches.
    private static let names: Set<String> = ["роки", "рокки", "rocky"]

    /// Nil means no anchored activation. An empty remainder is activation alone.
    /// Call only while waiting for an explicitly enabled voice activation mode.
    static func consume(_ text: String) -> String? {
        let input = trimSeparators(text[...])
        let first = token(in: input)
        guard names.contains(first.lowercased()) else { return nil }
        var remainder = trimSeparators(input.dropFirst(first.count))
        let second = token(in: remainder)
        if second == "2" || second.lowercased() == "два" {
            remainder = trimSeparators(remainder.dropFirst(second.count))
        }
        // Only separators around the activation are removed. Keep the dictated
        // remainder's case, punctuation, technical terms and spelling intact.
        return String(remainder).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Explicit opt-in gate. Nil in manual mode means "no activation action";
    /// the caller should continue its normal manual-dictation handling unchanged.
    static func consume(_ text: String, waitingForActivation: Bool) -> String? {
        guard waitingForActivation else { return nil }
        return consume(text)
    }

    private static func token(in text: Substring) -> Substring {
        text.prefix { !$0.isWhitespace && !$0.isPunctuation }
    }

    private static func trimSeparators(_ text: Substring) -> Substring {
        text.drop { $0.isWhitespace || $0.isPunctuation }
    }
}
