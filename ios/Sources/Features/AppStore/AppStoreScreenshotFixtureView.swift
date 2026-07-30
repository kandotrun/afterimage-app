#if DEBUG
import SwiftUI

enum AppStoreScreenshotScene: String, CaseIterable {
    case timeline
    case memory
    case analysis

    static var launchScene: AppStoreScreenshotScene? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-afterimageAppStoreScreenshotScene"),
              arguments.indices.contains(index + 1) else {
            return nil
        }
        return AppStoreScreenshotScene(rawValue: arguments[index + 1])
    }

    var readyIdentifier: String {
        "app-store-screenshot-ready-\(rawValue)"
    }
}

struct AppStoreScreenshotFixtureView: View {
    let scene: AppStoreScreenshotScene
    private let syntheticData = AppStoreScreenshotFixture.synthetic

    var body: some View {
        ZStack {
            AppStoreFixtureBackground()
            switch scene {
            case .timeline:
                AppStoreTimelineFixture(fixture: syntheticData)
            case .memory:
                AppStoreMemoryFixture(fixture: syntheticData)
            case .analysis:
                AppStoreAnalysisFixture(fixture: syntheticData)
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier(scene.readyIdentifier)
    }
}

private struct AppStoreScreenshotFixture {
    let location: String
    let transcript: String
    let summary: String
    let analysis: String

    static let synthetic = AppStoreScreenshotFixture(
        location: "代々木公園",
        transcript: "風が気持ちいいね。少し遠回りして帰ろう。",
        summary: "木漏れ日の道を歩いて、噴水のそばで夕空を眺めた穏やかな一日。",
        analysis: "公園の入口から木立を抜け、噴水へ向かう散歩。青空が夕焼けに変わっていく。"
    )
}

private struct AppStoreFixtureBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.04, green: 0.06, blue: 0.12),
                Color(red: 0.11, green: 0.08, blue: 0.15),
                Color(red: 0.05, green: 0.12, blue: 0.15),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(Color(red: 1.0, green: 0.38, blue: 0.31).opacity(0.17))
                .frame(width: 340, height: 340)
                .blur(radius: 76)
                .offset(x: 100, y: -110)
        }
    }
}

private struct AppStoreTimelineFixture: View {
    let fixture: AppStoreScreenshotFixture

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("afterimage")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.58))
                        Text("あなたの記録")
                            .font(.largeTitle.bold())
                    }
                    Spacer()
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.white.opacity(0.82))
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("7月30日 木曜日")
                            .font(.title2.bold())
                        Spacer()
                        Label("27°", systemImage: "sun.max.fill")
                            .font(.headline)
                            .foregroundStyle(Color(red: 1.0, green: 0.73, blue: 0.34))
                    }
                    Text(fixture.summary)
                        .font(.body)
                        .foregroundStyle(.white.opacity(0.72))
                        .lineSpacing(4)
                }

                VStack(alignment: .leading, spacing: 16) {
                    SyntheticParkVideoFrame(moment: .sunset)
                        .frame(height: 430)

                    HStack {
                        Label(fixture.location, systemImage: "mappin.and.ellipse")
                        Spacer()
                        Label("18:24", systemImage: "clock")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.74))

                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "quote.opening")
                            .foregroundStyle(Color(red: 1.0, green: 0.42, blue: 0.36))
                        Text(fixture.transcript)
                            .font(.headline)
                            .lineSpacing(3)
                    }
                    .padding(18)
                    .background(Color.white.opacity(0.08), in: .rect(cornerRadius: 18))
                }

                HStack(spacing: 14) {
                    AppStoreMiniMemory(
                        title: "噴水の音",
                        time: "18:31",
                        colors: [.cyan.opacity(0.68), .blue.opacity(0.34)]
                    )
                    AppStoreMiniMemory(
                        title: "帰り道の空",
                        time: "18:47",
                        colors: [.orange.opacity(0.76), .purple.opacity(0.42)]
                    )
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 44)
        }
        .scrollIndicators(.hidden)
    }
}

private struct AppStoreMemoryFixture: View {
    let fixture: AppStoreScreenshotFixture

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "chevron.left")
                Spacer()
                Text("7月30日 18:24")
                    .font(.headline)
                Spacer()
                Image(systemName: "ellipsis")
            }
            .font(.title3.weight(.semibold))
            .padding(.horizontal, 22)
            .padding(.vertical, 16)

            SyntheticParkVideoFrame(moment: .fountain)
                .frame(maxHeight: 760)
                .overlay(alignment: .bottom) {
                    VStack(spacing: 16) {
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.26))
                                Capsule()
                                    .fill(Color.white)
                                    .frame(width: proxy.size.width * 0.42)
                            }
                        }
                        .frame(height: 4)

                        HStack {
                            Text("0:18")
                            Spacer()
                            Button(action: {}) {
                                Image(systemName: "gobackward.10")
                            }
                            Button(action: {}) {
                                Image(systemName: "pause.fill")
                                    .font(.title2)
                            }
                            Button(action: {}) {
                                Image(systemName: "goforward.10")
                            }
                            Spacer()
                            Text("0:43")
                        }
                        .font(.subheadline.monospacedDigit())
                    }
                    .padding(20)
                    .background(
                        LinearGradient(
                            colors: [.clear, .black.opacity(0.78)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                }

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        Label(fixture.location, systemImage: "mappin.and.ellipse")
                            .font(.headline)
                        Spacer()
                        Text("2026年7月30日")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.58))
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Label("文字起こし", systemImage: "waveform")
                            .font(.headline)
                            .foregroundStyle(Color(red: 1.0, green: 0.48, blue: 0.41))
                        Text("「噴水の音が聞こえる。今日は空がきれい。\(fixture.transcript)」")
                            .font(.title3)
                            .lineSpacing(5)
                    }
                    .padding(20)
                    .background(Color.white.opacity(0.08), in: .rect(cornerRadius: 20))
                }
                .padding(24)
            }
            .scrollIndicators(.hidden)
        }
    }
}

private struct AppStoreAnalysisFixture: View {
    let fixture: AppStoreScreenshotFixture

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack {
                    Image(systemName: "chevron.left")
                    Spacer()
                    Text("動画の解析")
                        .font(.headline)
                    Spacer()
                    Image(systemName: "sparkles")
                        .foregroundStyle(Color(red: 1.0, green: 0.48, blue: 0.41))
                }
                .font(.title3.weight(.semibold))

                SyntheticParkVideoFrame(moment: .path)
                    .frame(height: 360)

                VStack(alignment: .leading, spacing: 14) {
                    Label("映像から見つかったこと", systemImage: "sparkles")
                        .font(.title2.bold())
                        .foregroundStyle(Color(red: 1.0, green: 0.55, blue: 0.44))
                    Text(fixture.analysis)
                        .font(.title3)
                        .lineSpacing(5)
                        .foregroundStyle(.white.opacity(0.86))
                }
                .padding(22)
                .background(
                    LinearGradient(
                        colors: [
                            Color(red: 1.0, green: 0.34, blue: 0.30).opacity(0.18),
                            Color.white.opacity(0.07),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: .rect(cornerRadius: 24)
                )

                VStack(alignment: .leading, spacing: 18) {
                    Text("場面")
                        .font(.title3.bold())
                    AppStoreAnalysisSegment(
                        time: "0:00",
                        icon: "figure.walk",
                        text: "木漏れ日の小道を歩き始める"
                    )
                    AppStoreAnalysisSegment(
                        time: "0:14",
                        icon: "water.waves",
                        text: "噴水のそばで立ち止まり、水音を聞く"
                    )
                    AppStoreAnalysisSegment(
                        time: "0:31",
                        icon: "sunset.fill",
                        text: "木々の向こうに広がる夕空を見上げる"
                    )
                }

                VStack(alignment: .leading, spacing: 10) {
                    Label(fixture.location, systemImage: "mappin.and.ellipse")
                        .font(.headline)
                    Text("この記録は、検索で「噴水」「夕空」「散歩」から見つけられます。")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.64))
                        .lineSpacing(4)
                }
                .padding(20)
                .background(Color.white.opacity(0.07), in: .rect(cornerRadius: 20))
            }
            .padding(.horizontal, 24)
            .padding(.top, 18)
            .padding(.bottom, 42)
        }
        .scrollIndicators(.hidden)
    }
}

private struct AppStoreAnalysisSegment: View {
    let time: String
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.09))
                Image(systemName: icon)
                    .foregroundStyle(Color(red: 1.0, green: 0.55, blue: 0.44))
            }
            .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 4) {
                Text(time)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.white.opacity(0.5))
                Text(text)
                    .font(.body.weight(.medium))
            }
        }
    }
}

private struct AppStoreMiniMemory: View {
    let title: String
    let time: String
    let colors: [Color]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack {
                LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: "play.fill")
                    .font(.title2)
                    .foregroundStyle(.white)
                    .padding(14)
                    .background(.black.opacity(0.32), in: .circle)
            }
            .frame(height: 128)
            .clipShape(.rect(cornerRadius: 16))
            Text(title)
                .font(.headline)
            Text(time)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.56))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.06), in: .rect(cornerRadius: 20))
    }
}

private struct SyntheticParkVideoFrame: View {
    enum Moment {
        case sunset
        case fountain
        case path
    }

    let moment: Moment

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack {
                LinearGradient(
                    colors: skyColors,
                    startPoint: .top,
                    endPoint: .bottom
                )

                Circle()
                    .fill(Color(red: 1.0, green: 0.84, blue: 0.48))
                    .frame(width: size.width * 0.18)
                    .blur(radius: 2)
                    .offset(x: size.width * 0.24, y: -size.height * 0.25)

                AppStoreTreeLine()
                    .frame(height: size.height * 0.5)
                    .offset(y: size.height * 0.2)

                if moment == .fountain {
                    AppStoreFountain()
                        .frame(width: size.width * 0.42, height: size.height * 0.34)
                        .offset(y: size.height * 0.2)
                } else {
                    Path { path in
                        path.move(to: CGPoint(x: size.width * 0.42, y: size.height * 0.54))
                        path.addCurve(
                            to: CGPoint(x: size.width * 0.72, y: size.height),
                            control1: CGPoint(x: size.width * 0.36, y: size.height * 0.74),
                            control2: CGPoint(x: size.width * 0.62, y: size.height * 0.82)
                        )
                        path.addLine(to: CGPoint(x: size.width * 0.26, y: size.height))
                        path.addCurve(
                            to: CGPoint(x: size.width * 0.42, y: size.height * 0.54),
                            control1: CGPoint(x: size.width * 0.42, y: size.height * 0.84),
                            control2: CGPoint(x: size.width * 0.48, y: size.height * 0.66)
                        )
                    }
                    .fill(Color(red: 0.75, green: 0.61, blue: 0.43).opacity(0.8))
                }

                LinearGradient(
                    colors: [.clear, .black.opacity(0.38)],
                    startPoint: .center,
                    endPoint: .bottom
                )

                VStack {
                    Spacer()
                    HStack {
                        Image(systemName: "play.fill")
                            .font(.headline)
                            .padding(13)
                            .background(.black.opacity(0.42), in: .circle)
                        Spacer()
                        Text("0:43")
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7)
                            .background(.black.opacity(0.42), in: .capsule)
                    }
                    .padding(16)
                }
            }
            .clipShape(.rect(cornerRadius: 26))
            .overlay {
                RoundedRectangle(cornerRadius: 26)
                    .stroke(Color.white.opacity(0.12), lineWidth: 1)
            }
        }
    }

    private var skyColors: [Color] {
        switch moment {
        case .sunset:
            return [
                Color(red: 0.18, green: 0.43, blue: 0.68),
                Color(red: 0.94, green: 0.48, blue: 0.35),
                Color(red: 0.21, green: 0.35, blue: 0.25),
            ]
        case .fountain:
            return [
                Color(red: 0.18, green: 0.57, blue: 0.82),
                Color(red: 0.55, green: 0.79, blue: 0.88),
                Color(red: 0.18, green: 0.43, blue: 0.29),
            ]
        case .path:
            return [
                Color(red: 0.30, green: 0.57, blue: 0.74),
                Color(red: 0.91, green: 0.61, blue: 0.42),
                Color(red: 0.17, green: 0.38, blue: 0.25),
            ]
        }
    }
}

private struct AppStoreTreeLine: View {
    var body: some View {
        HStack(alignment: .bottom, spacing: -12) {
            ForEach(0..<8, id: \.self) { index in
                VStack(spacing: -8) {
                    Circle()
                        .fill(index.isMultiple(of: 2)
                            ? Color(red: 0.08, green: 0.27, blue: 0.18)
                            : Color(red: 0.12, green: 0.36, blue: 0.23))
                        .frame(width: index.isMultiple(of: 3) ? 92 : 76)
                    Rectangle()
                        .fill(Color(red: 0.20, green: 0.16, blue: 0.10))
                        .frame(width: 12, height: 74)
                }
            }
        }
    }
}

private struct AppStoreFountain: View {
    var body: some View {
        ZStack(alignment: .bottom) {
            Ellipse()
                .fill(Color(red: 0.20, green: 0.55, blue: 0.70))
                .frame(height: 48)
            ForEach([-0.32, 0, 0.32] as [CGFloat], id: \.self) { offset in
                Capsule()
                    .fill(Color.white.opacity(0.74))
                    .frame(width: 7, height: offset == 0 ? 150 : 112)
                    .offset(x: offset * 160, y: -22)
            }
        }
    }
}
#endif
