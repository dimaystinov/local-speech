import Foundation
@main struct EvaluateRefinement {
    static func main() throws {
        guard CommandLine.arguments.count == 4 else { throw NSError(domain: "Usage: baseline candidate output", code: 1) }
        let a = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        let b = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
        let candidate = Dictionary(uniqueKeysWithValues: (b["rows"] as! [[String: Any]]).map { ($0["id"] as! String, $0) })
        var rows: [[String: Any]] = []
        for var row in a["rows"] as! [[String: Any]] {
            guard let other = candidate[row["id"] as! String], let raw = row["segments"] as? [String], let proposed = other["segments"] as? [String], raw.count == proposed.count else { throw NSError(domain: "Unpaired recording", code: 2) }
            row["baselineText"] = row["text"]
            let selected = zip(raw, proposed).map { RefinementPolicy.accept(original: $0.0, candidate: $0.1) ? $0.1 : $0.0 }
            row["text"] = selected.joined(separator: " ")
            row["acceptedSegments"] = zip(raw, selected).filter { $0 != $1 }.count
            rows.append(row)
        }
        let out: [String: Any] = ["rows": rows, "complete": a["complete"] as? Bool == true && b["complete"] as? Bool == true, "policy": "Exact application RefinementPolicy, no reference supplied to policy"]
        try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted,.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
    }
}
