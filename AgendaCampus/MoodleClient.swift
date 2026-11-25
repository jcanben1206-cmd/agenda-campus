import Foundation

struct MoodleClient {
    private let base: URL
    private let token: String

    init(site: String, token: String) throws {
        let address = site.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: address),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              let url = parts.url else { throw MoodleError.address }
        base = url
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !self.token.isEmpty else { throw MoodleError.access }
    }

    func assignments() async throws -> [AgendaItem] {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let response: Courses = try await call("mod_assign_get_assignments", session: session)
        var seen = Set<Int>()
        var items: [AgendaItem] = []
        for course in response.courses {
            for task in course.assignments where seen.insert(task.id).inserted {
                var state: Submission = task.nosubmissions == 1 ? .exempt : .unknown
                var deadline = task.duedate
                if state != .exempt {
                    let status: Status? = try? await call(
                        "mod_assign_get_submission_status", session: session,
                        parameters: ["assignid": String(task.id)]
                    )
                    if let attempt = status?.lastattempt {
                        state = attempt.state(group: task.teamsubmission == 1, requireAll: task.requireallteammemberssubmit == 1)
                        deadline = max(deadline, attempt.extensionduedate ?? 0)
                    }
                }
                try Task.checkCancellation()
                let path = base.appendingPathComponent("mod/assign/view.php")
                var link = URLComponents(url: path, resolvingAgainstBaseURL: false)
                link?.queryItems = [URLQueryItem(name: "id", value: String(task.cmid))]
                items.append(.init(
                    id: "moodle.\(base.absoluteString).\(task.id)",
                    title: task.name, course: course.fullname,
                    date: deadline > 0 ? Date(timeIntervalSince1970: Double(deadline)) : nil,
                    kind: .assignment, submission: state, link: link?.url
                ))
            }
        }
        return items
    }

    private func call<T: Decodable>(_ function: String, session: URLSession, parameters: [String: String] = [:]) async throws -> T {
        let endpoint = base.appendingPathComponent("webservice/rest/server.php")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let fields = ["wstoken": token, "wsfunction": function, "moodlewsrestformat": "json"]
            .merging(parameters) { current, _ in current }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        let encoded = fields.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&")
        request.httpBody = Data(encoded.utf8)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw MoodleError.connection
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MoodleError.connection
        }
        let decoder = JSONDecoder()
        if (try? decoder.decode(ServiceError.self, from: data)) != nil { throw MoodleError.access }
        guard let result = try? decoder.decode(T.self, from: data) else { throw MoodleError.response }
        return result
    }

    private struct Courses: Decodable {
        struct Course: Decodable {
            struct Assignment: Decodable {
                let id: Int
                let cmid: Int
                let name: String
                let duedate: Int
                let nosubmissions: Int
                let teamsubmission: Int
                let requireallteammemberssubmit: Int
            }
            let fullname: String
            let assignments: [Assignment]
        }
        let courses: [Course]
    }

    private struct Status: Decodable {
        struct Attempt: Decodable {
            struct Record: Decodable { let status: String }
            let submission: Record?
            let teamsubmission: Record?
            let submissionsenabled: Bool
            let extensionduedate: Int?

            private enum CodingKeys: String, CodingKey {
                case submission, teamsubmission, submissionsenabled, extensionduedate
            }

            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                submission = try values.decodeIfPresent(Record.self, forKey: .submission)
                teamsubmission = try values.decodeIfPresent(Record.self, forKey: .teamsubmission)
                extensionduedate = try values.decodeIfPresent(Int.self, forKey: .extensionduedate)
                if let enabled = try? values.decode(Bool.self, forKey: .submissionsenabled) {
                    submissionsenabled = enabled
                } else {
                    submissionsenabled = try values.decode(Int.self, forKey: .submissionsenabled) == 1
                }
            }

            func state(group: Bool, requireAll: Bool) -> Submission {
                if !submissionsenabled { return .exempt }
                if group && requireAll && submission?.status == "submitted" && teamsubmission?.status != "submitted" {
                    return .unknown
                }
                switch (group ? teamsubmission : submission)?.status {
                case "submitted": return .submitted
                case nil, "new", "draft", "reopened": return .pending
                default: return .unknown
                }
            }
        }
        let lastattempt: Attempt?
    }

    private struct ServiceError: Decodable { let exception: String }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}

private enum MoodleError: LocalizedError {
    case address, connection, access, response

    var errorDescription: String? {
        switch self {
        case .address: return "Introduce la dirección HTTPS de tu Moodle, sin parámetros ni enlaces de acceso."
        case .connection: return "No se pudo conectar con Moodle. Comprueba la dirección y la conexión."
        case .access: return "Moodle rechazó la solicitud. Comprueba el token y los permisos del servicio web."
        case .response: return "La respuesta de Moodle no es compatible con esta versión de la app."
        }
    }
}
