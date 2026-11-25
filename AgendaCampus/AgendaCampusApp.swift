import SwiftUI
import UserNotifications

enum ItemKind: String, Codable {
    case assignment, exam

    var icon: String { self == .exam ? "graduationcap" : "doc.text" }
}

enum Submission: String, Codable {
    case pending, submitted, unknown, exempt
}

struct AgendaItem: Identifiable, Codable, Equatable {
    let id: String
    let title: String
    let course: String
    let date: Date?
    let kind: ItemKind
    let submission: Submission
    var link: URL? = nil

    var status: String {
        switch submission {
        case .submitted: return "Entregada"
        case .unknown: return "Sin verificar"
        case .exempt: return "Sin entrega"
        case .pending:
            if kind == .exam { return "Examen" }
            return date.map { $0 < .now } == true ? "Fuera de plazo" : "Pendiente"
        }
    }

    static func demo() -> [Self] {
        let calendar = Calendar.current
        func day(_ offset: Int) -> Date {
            let date = calendar.date(byAdding: .day, value: offset, to: .now) ?? .now
            return calendar.date(bySettingHour: 18, minute: 0, second: 0, of: date) ?? date
        }
        return [
            .init(id: "demo-1", title: "Comentario de texto", course: "Lengua", date: day(1), kind: .assignment, submission: .pending),
            .init(id: "demo-2", title: "Problemas de funciones", course: "Matemáticas", date: day(-1), kind: .assignment, submission: .pending),
            .init(id: "demo-3", title: "Informe de laboratorio", course: "Biología", date: day(4), kind: .assignment, submission: .submitted),
            .init(id: "demo-4", title: "Examen de historia", course: "Historia", date: day(7), kind: .exam, submission: .pending)
        ]
    }
}

@main
struct AgendaCampusApp: App {
    var body: some Scene {
        WindowGroup { CampusView() }
    }
}

struct CampusView: View {
    @AppStorage("campus.exams") private var examData = Data()
    @AppStorage("campus.assignments") private var assignmentData = Data()
    @AppStorage("campus.live") private var live = false
    @AppStorage("campus.site") private var site = ""
    @AppStorage("campus.reminders") private var reminders = false
    @State private var demo = AgendaItem.demo()
    @State private var token = ""
    @State private var syncing = false
    @State private var feedback = ""
    @State private var notificationFeedback = ""
    @State private var selectedDay = Date.now
    @State private var addingExam = false
    @State private var pendingOnly = false
    @State private var activation = 0
    @Environment(\.scenePhase) private var phase

    private var exams: [AgendaItem] { decode(examData) }
    private var assignments: [AgendaItem] { live ? decode(assignmentData) : demo.filter { $0.kind == .assignment } }
    private var items: [AgendaItem] {
        (assignments + exams + (live ? [] : demo.filter { $0.kind == .exam }))
            .sorted { ($0.date ?? .distantFuture) < ($1.date ?? .distantFuture) }
    }
    private var displayedAssignments: [AgendaItem] {
        items.filter { $0.kind == .assignment && (!pendingOnly || $0.submission == .pending) }
    }
    private var selectedItems: [AgendaItem] {
        items.filter { item in
            item.date.map { Calendar.current.isDate($0, inSameDayAs: selectedDay) } ?? false
        }
    }
    private var notificationItems: [AgendaItem] {
        reminders ? (exams + (live ? assignments : [])).filter { $0.submission == .pending } : []
    }

    private struct NotificationUpdate: Equatable {
        let items: [AgendaItem]
        let enabled: Bool
        let activation: Int
    }

    var body: some View {
        TabView {
            NavigationStack {
                List {
                    if !live { Label("Modo de demostración", systemImage: "sparkles") }
                    Toggle("Solo pendientes", isOn: $pendingOnly)
                    Section("Entregas") {
                        if displayedAssignments.isEmpty { Text("No hay tareas en esta vista.").foregroundStyle(.secondary) }
                        ForEach(displayedAssignments) { item in
                            if let link = item.link {
                                Link(destination: link) { ItemRow(item: item) }
                            } else {
                                ItemRow(item: item)
                            }
                        }
                    }
                }
                .navigationTitle("Tareas")
            }
            .tabItem { Label("Tareas", systemImage: "checklist") }

            NavigationStack {
                List {
                    DatePicker("Día", selection: $selectedDay, displayedComponents: .date)
                        .datePickerStyle(.graphical)
                    Section(selectedDay.formatted(date: .complete, time: .omitted)) {
                        if selectedItems.isEmpty { Text("Sin tareas ni exámenes para este día.").foregroundStyle(.secondary) }
                        ForEach(selectedItems) { ItemRow(item: $0) }
                    }
                    Section("Próximas fechas") {
                        ForEach(items.filter { $0.date.map { $0 >= Calendar.current.startOfDay(for: .now) } ?? false }) { item in
                            Button {
                                if let date = item.date { selectedDay = date }
                            } label: {
                                ItemRow(item: item)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .navigationTitle("Calendario")
                .toolbar { addExamButton }
            }
            .tabItem { Label("Calendario", systemImage: "calendar") }

            NavigationStack {
                List {
                    if !live, let sample = demo.first(where: { $0.kind == .exam }) {
                        Section("Ejemplo") { ItemRow(item: sample) }
                    }
                    Section("Mis exámenes") {
                        if exams.isEmpty { Text("Añade tu primer examen con el botón +.").foregroundStyle(.secondary) }
                        ForEach(exams.sorted { ($0.date ?? .distantFuture) < ($1.date ?? .distantFuture) }) { item in
                            ItemRow(item: item)
                                .swipeActions {
                                    Button("Eliminar", role: .destructive) {
                                        saveExams(exams.filter { $0.id != item.id })
                                    }
                                }
                        }
                    }
                }
                .navigationTitle("Exámenes")
                .toolbar { addExamButton }
            }
            .tabItem { Label("Exámenes", systemImage: "graduationcap") }

            NavigationStack {
                Form {
                    Section {
                        TextField("https://moodle.tu-centro.es", text: $site)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(syncing)
                        SecureField("Token de servicios web", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(syncing)
                        Button("Sincronizar tareas") { Task { await sync() } }
                            .disabled(syncing || site.isEmpty || token.isEmpty)
                        if syncing { ProgressView("Sincronizando…") }
                        if !feedback.isEmpty { Text(feedback).font(.footnote) }
                        if live {
                            Button("Volver a la demostración", role: .destructive) {
                                token = ""
                                assignmentData = Data()
                                live = false
                                feedback = ""
                            }
                            .disabled(syncing)
                        }
                    } header: {
                        Text("Moodle")
                    } footer: {
                        Text("Tu centro debe habilitar los servicios web. El token se guarda solo en memoria.")
                    }
                    Section {
                        Toggle("Recordatorios de tareas y exámenes", isOn: $reminders)
                        if !notificationFeedback.isEmpty { Text(notificationFeedback).font(.footnote) }
                    } header: {
                        Text("Avisos")
                    } footer: {
                        Text("Avisos 24 horas y 1 hora antes. También se avisa al vencer una tarea que seguía pendiente en la última sincronización.")
                    }
                }
                .navigationTitle("Ajustes")
            }
            .tabItem { Label("Ajustes", systemImage: "gearshape") }
        }
        .tint(.indigo)
        .sheet(isPresented: $addingExam) {
            ExamForm { saveExams(exams + [$0]) }
        }
        .task(id: NotificationUpdate(items: notificationItems, enabled: reminders, activation: activation)) {
            await updateNotifications()
        }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { activation += 1 }
        }
    }

    private var addExamButton: some View {
        Button {
            addingExam = true
        } label: {
            Label("Añadir examen", systemImage: "plus")
        }
    }

    private func decode(_ data: Data) -> [AgendaItem] {
        (try? JSONDecoder().decode([AgendaItem].self, from: data)) ?? []
    }

    private func saveExams(_ entries: [AgendaItem]) {
        if let data = try? JSONEncoder().encode(entries) { examData = data }
    }

    @MainActor private func sync() async {
        guard !syncing else { return }
        syncing = true
        feedback = ""
        defer { syncing = false }
        do {
            let client = try MoodleClient(site: site, token: token)
            let entries = try await client.assignments()
            assignmentData = try JSONEncoder().encode(entries)
            live = true
            let unknown = entries.filter { $0.submission == .unknown }.count
            feedback = "Tareas sincronizadas: \(entries.count)."
            if unknown > 0 { feedback += " Sin estado confirmado: \(unknown)." }
        } catch {
            feedback = error.localizedDescription
        }
    }

    @MainActor private func updateNotifications() async {
        let center = UNUserNotificationCenter.current()
        let existing = await center.pendingNotificationRequests()
        guard !Task.isCancelled else { return }
        let prefixed = existing.filter { $0.identifier.hasPrefix("campus.") }
        let enabled = reminders
        do {
            if enabled {
                let settings = await center.notificationSettings()
                let allowed: Bool
                if settings.authorizationStatus == .notDetermined {
                    allowed = try await center.requestAuthorization(options: [.alert, .sound])
                } else {
                    allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
                }
                guard !Task.isCancelled, reminders == enabled else { return }
                if !allowed {
                    notificationFeedback = "Permite los avisos de Agenda Campus en Ajustes del iPhone."
                    return
                }
            }
            notificationFeedback = ""
            let now = Date.now
            let requests = notificationItems.flatMap { item in
                let offsets = item.kind == .exam ? [24, 1] : [24, 1, 0]
                return offsets.compactMap { hours -> (String, Date, AgendaItem, Int)? in
                    guard let date = item.date?.addingTimeInterval(-Double(hours) * 3600), date > now else { return nil }
                    return ("campus.\(item.id).\(hours)", date, item, hours)
                }
            }.sorted { $0.1 < $1.1 }.prefix(60)
            let desired = Set(requests.map { $0.0 })
            center.removePendingNotificationRequests(withIdentifiers: prefixed.map(\.identifier).filter { !desired.contains($0) })
            for (id, date, item, hours) in requests {
                guard !Task.isCancelled, reminders else { return }
                let content = UNMutableNotificationContent()
                content.title = item.title
                if hours == 0 {
                    content.body = "Vence ahora. Figuraba pendiente en la última sincronización."
                } else if item.kind == .exam {
                    content.body = "Tu examen es en \(hours) h."
                } else {
                    content.body = "El plazo de entrega termina en \(hours) h."
                }
                content.sound = .default
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
                try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
            }
        } catch {
            if !Task.isCancelled { notificationFeedback = "No se pudieron actualizar todos los recordatorios." }
        }
    }
}

private struct ItemRow: View {
    let item: AgendaItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.kind.icon)
                .font(.headline)
                .foregroundStyle(Color.indigo)
                .frame(width: 26)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(item.title).font(.headline).foregroundStyle(.primary)
                if !item.course.isEmpty { Text(item.course).foregroundStyle(.secondary) }
                if let date = item.date {
                    Text(date, format: .dateTime.day().month(.abbreviated).hour().minute())
                        .foregroundStyle(.secondary)
                } else {
                    Text("Sin fecha límite").foregroundStyle(.secondary)
                }
                Text(item.status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(item.submission == .submitted ? Color.green : Color.indigo)
            }
            .font(.subheadline)
        }
        .padding(.vertical, 4)
    }
}

private struct ExamForm: View {
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var course = ""
    @State private var date = Date.now.addingTimeInterval(86400)
    var save: (AgendaItem) -> Void

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nombre del examen", text: $title)
                TextField("Asignatura (opcional)", text: $course)
                DatePicker("Fecha y hora", selection: $date)
            }
            .navigationTitle("Nuevo examen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") {
                        save(.init(id: UUID().uuidString, title: trimmedTitle,
                                   course: course.trimmingCharacters(in: .whitespacesAndNewlines),
                                   date: date, kind: .exam, submission: .pending))
                        dismiss()
                    }
                    .disabled(trimmedTitle.isEmpty)
                }
            }
        }
    }
}
