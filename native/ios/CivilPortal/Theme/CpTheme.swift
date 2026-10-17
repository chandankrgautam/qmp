// GENERATED from tokens/tokens.json by tokens/build-tokens.mjs. Do not edit.
import SwiftUI
import UIKit

extension Color {
    /// A colour that follows the system light/dark setting.
    init(light: Color, dark: Color) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }

    static let cpBg = Color(light: Color(red: 0.9725, green: 0.9647, blue: 0.9373), dark: Color(red: 0.0549, green: 0.102, blue: 0.102))
    static let cpSurface = Color(light: Color(red: 1, green: 1, blue: 1), dark: Color(red: 0.0824, green: 0.1412, blue: 0.1412))
    static let cpMuted = Color(light: Color(red: 0.9373, green: 0.9294, blue: 0.8941), dark: Color(red: 0.1059, green: 0.1804, blue: 0.1804))
    static let cpTint = Color(light: Color(red: 0.9098, green: 0.9569, blue: 0.9569), dark: Color(red: 0.1137, green: 0.2196, blue: 0.2196))
    static let cpBorder = Color(light: Color(red: 0.9176, green: 0.9098, blue: 0.8784), dark: Color(red: 0.1333, green: 0.2235, blue: 0.2275))
    static let cpBorderStrong = Color(light: Color(red: 0.8667, green: 0.851, blue: 0.8), dark: Color(red: 0.1804, green: 0.2902, blue: 0.2941))
    static let cpText = Color(light: Color(red: 0.1098, green: 0.1686, blue: 0.1686), dark: Color(red: 0.9059, green: 0.9294, blue: 0.9176))
    static let cpTextMuted = Color(light: Color(red: 0.3804, green: 0.4392, blue: 0.4549), dark: Color(red: 0.6431, green: 0.7059, blue: 0.702))
    static let cpPrimary = Color(light: Color(red: 0.0588, green: 0.298, blue: 0.298), dark: Color(red: 0.5608, green: 0.8275, blue: 0.7961))
    static let cpPrimaryHover = Color(light: Color(red: 0.0471, green: 0.2471, blue: 0.2471), dark: Color(red: 0.1216, green: 0.4784, blue: 0.4784))
    static let cpPrimaryPressed = Color(light: Color(red: 0.0392, green: 0.2, blue: 0.2), dark: Color(red: 0.0392, green: 0.2, blue: 0.2))
    static let cpPrimaryButton = Color(light: Color(red: 0.0588, green: 0.298, blue: 0.298), dark: Color(red: 0.102, green: 0.4196, blue: 0.4196))
    static let cpOnPrimary = Color(light: Color(red: 1, green: 1, blue: 1), dark: Color(red: 1, green: 1, blue: 1))
    static let cpSidebar = Color(light: Color(red: 0.0588, green: 0.298, blue: 0.298), dark: Color(red: 0.0431, green: 0.149, blue: 0.149))
    static let cpRowHover = Color(light: Color(red: 0.9843, green: 0.9804, blue: 0.9647), dark: Color(red: 0.0941, green: 0.1608, blue: 0.1608))
    static let cpFocus = Color(light: Color(red: 0.0588, green: 0.298, blue: 0.298), dark: Color(red: 0.5608, green: 0.8275, blue: 0.7961))
    static let cpPrimaryDark = Color(red: 0.0392, green: 0.2, blue: 0.2)
    static let cpSecondary = Color(red: 0.1804, green: 0.4902, blue: 0.1961)
    static let cpGold = Color(red: 0.7882, green: 0.6627, blue: 0.4157)
    static let cpGoldHover = Color(red: 0.749, green: 0.6118, blue: 0.3451)
    static let cpGoldText = Color(red: 0.6902, green: 0.5608, blue: 0.3059)
    static let cpEmSlot = Color(red: 0.4784, green: 0.2941, blue: 0.1216)
    // Status: meaning only, always with an SF Symbol and a label.
    static let cpResolved = Color(light: Color(red: 0.1216, green: 0.4353, blue: 0.2902), dark: Color(red: 0.498, green: 0.8275, blue: 0.651))
    static let cpResolvedBg = Color(light: Color(red: 0.902, green: 0.949, blue: 0.9255), dark: Color(red: 0.0902, green: 0.2, blue: 0.1569))
    static let cpAtRisk = Color(light: Color(red: 0.5412, green: 0.3529, blue: 0), dark: Color(red: 0.9098, green: 0.698, blue: 0.3529))
    static let cpAtRiskBg = Color(light: Color(red: 0.9843, green: 0.9451, blue: 0.8627), dark: Color(red: 0.2, green: 0.1569, blue: 0.0588))
    static let cpBreached = Color(light: Color(red: 0.6392, green: 0.1647, blue: 0.1294), dark: Color(red: 0.9412, green: 0.5294, blue: 0.4941))
    static let cpBreachedBg = Color(light: Color(red: 0.9843, green: 0.9059, blue: 0.898), dark: Color(red: 0.2275, green: 0.1098, blue: 0.102))
    static let cpInfo = Color(light: Color(red: 0.1725, green: 0.3529, blue: 0.5412), dark: Color(red: 0.5529, green: 0.7137, blue: 0.8784))
    static let cpInfoBg = Color(light: Color(red: 0.902, green: 0.9333, blue: 0.9686), dark: Color(red: 0.0863, green: 0.149, blue: 0.2275))
    static let cpReopened = Color(light: Color(red: 0.4157, green: 0.2392, blue: 0.5608), dark: Color(red: 0.7647, green: 0.6392, blue: 0.8784))
    static let cpReopenedBg = Color(light: Color(red: 0.9451, green: 0.9176, blue: 0.9686), dark: Color(red: 0.1647, green: 0.1216, blue: 0.2118))
    static let cpAwaiting = Color(light: Color(red: 0.3569, green: 0.3098, blue: 0.6588), dark: Color(red: 0.6627, green: 0.6235, blue: 0.9176))
    static let cpAwaitingBg = Color(light: Color(red: 0.9255, green: 0.9176, blue: 0.9725), dark: Color(red: 0.1333, green: 0.1216, blue: 0.2275))
}

enum CpRadius {
    static let xs: CGFloat = 6
    static let input: CGFloat = 10
    static let card: CGFloat = 14
    static let cardLarge: CGFloat = 16
    static let dialog: CGFloat = 20
    static let sheet: CGFloat = 24
    static let pill: CGFloat = 999
}

enum CpSpace {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s7: CGFloat = 28
    static let s8: CGFloat = 32
    static let s10: CGFloat = 40
    static let s12: CGFloat = 48
    static let s16: CGFloat = 64
}

enum CpFont {
    /// Poppins, scaled with Dynamic Type relative to the matching text style.
    static let display = Font.custom("Poppins", size: 48, relativeTo: .largeTitle).weight(.bold)
    static let h1 = Font.custom("Poppins", size: 30, relativeTo: .title).weight(.bold)
    static let h2 = Font.custom("Poppins", size: 22, relativeTo: .title2).weight(.semibold)
    static let h3 = Font.custom("Poppins", size: 18, relativeTo: .title3).weight(.semibold)
    static let h4 = Font.custom("Poppins", size: 16, relativeTo: .headline).weight(.semibold)
    static let body = Font.custom("Poppins", size: 14, relativeTo: .body).weight(.regular)
    static let small = Font.custom("Poppins", size: 13, relativeTo: .subheadline).weight(.regular)
    static let caption = Font.custom("Poppins", size: 12, relativeTo: .caption).weight(.medium)
    static let label = Font.custom("Poppins", size: 11, relativeTo: .caption2).weight(.semibold)
    static let kpi = Font.custom("Poppins", size: 30, relativeTo: .title).weight(.bold)
}

enum CpTouch {
    static let minTarget: CGFloat = 44
}
