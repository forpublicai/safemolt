/**
 * Verification status badges for agent profiles.
 * Displays PoAW, Identity, and Twitter verification status as card-style buttons.
 */

interface VerificationBadgesProps {
    isVetted?: boolean;
    hasIdentity?: boolean;
    hasTwitterOwner?: boolean;
}

interface BadgeConfig {
    icon: string;
    label: string;
    passedDetail: string;
    pendingDetail: string;
}

const badges: Record<"poaw" | "identity" | "twitter", BadgeConfig> = {
    poaw: {
        icon: "🧠",
        label: "PoAW",
        passedDetail: "Verified",
        pendingDetail: "Complete challenge",
    },
    identity: {
        icon: "📝",
        label: "Identity",
        passedDetail: "✓ valid",
        pendingDetail: "Submit IDENTITY.md",
    },
    twitter: {
        icon: "🐦",
        label: "Twitter",
        passedDetail: "Owner verified",
        pendingDetail: "Verify ownership",
    },
};

function Badge({
    config,
    passed,
}: {
    config: BadgeConfig;
    passed: boolean;
}) {
    return (
        <div
            className={`
        flex flex-col items-center justify-center p-3 rounded-lg border transition-colors
        ${passed
                    ? "border-safemolt-success bg-safemolt-success/10"
                    : "border-safemolt-border bg-safemolt-card"
                }
      `}
        >
            <span className="text-2xl mb-1">{config.icon}</span>
            <span className="text-xs font-medium text-safemolt-text mb-1">
                {config.label}
            </span>
            <span
                className={`
          text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide
          ${passed
                        ? "bg-safemolt-success/20 text-safemolt-success"
                        : "bg-safemolt-border/50 text-safemolt-text-muted"
                    }
        `}
            >
                {passed ? "Passed" : "Pending"}
            </span>
            <span className="text-[10px] text-safemolt-text-muted mt-1 text-center">
                {passed ? config.passedDetail : config.pendingDetail}
            </span>
        </div>
    );
}

export function VerificationBadges({
    isVetted = false,
    hasIdentity = false,
    hasTwitterOwner = false,
}: VerificationBadgesProps) {
    return (
        <div className="grid grid-cols-3 gap-2">
            <Badge config={badges.poaw} passed={isVetted} />
            <Badge config={badges.identity} passed={hasIdentity} />
            <Badge config={badges.twitter} passed={hasTwitterOwner} />
        </div>
    );
}
