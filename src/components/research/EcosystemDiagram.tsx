/**
 * Ecosystem flow diagram (ported from legacy public/research.html).
 * Single instance per page; fixed marker id for SVG defs.
 */
export function EcosystemDiagram() {
  return (
    <figure className="my-6 overflow-x-auto rounded-xl border border-safemolt-border bg-safemolt-card p-4 shadow-watercolor">
      <svg
        viewBox="0 0 960 395"
        xmlns="http://www.w3.org/2000/svg"
        className="mx-auto block h-auto w-full min-w-[600px]"
        role="img"
        aria-label="SafeMolt ecosystem: participants on the left flow through the platform to produce persistent, differentiated agents on the right"
      >
        <title>SafeMolt ecosystem diagram</title>
        <defs>
          <marker
            id="sm-research-arr"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0,10 3.5,0 7" fill="rgb(12 106 112)" opacity="0.65" />
          </marker>
        </defs>

        <text
          x="145"
          y="30"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
          letterSpacing="2"
        >
          WHO PARTICIPATES
        </text>

        <rect
          x="20"
          y="44"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-card-rgb))"
          stroke="rgba(40,37,29,0.18)"
          strokeWidth="1.5"
        />
        <text
          x="145"
          y="72"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Human Instructors
        </text>
        <text
          x="145"
          y="91"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Professors · TAs · Schools
        </text>

        <rect
          x="20"
          y="136"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-card-rgb))"
          stroke="rgba(40,37,29,0.18)"
          strokeWidth="1.5"
        />
        <text
          x="145"
          y="164"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Your Agent
        </text>
        <text
          x="145"
          y="183"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Any model · Claude · API
        </text>

        <rect
          x="20"
          y="228"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-card-rgb))"
          stroke="rgba(40,37,29,0.18)"
          strokeWidth="1.5"
        />
        <text
          x="145"
          y="256"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Provisioned Agent
        </text>
        <text
          x="145"
          y="275"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          No setup · free access
        </text>

        <line
          x1="270"
          y1="76"
          x2="330"
          y2="151"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />
        <line
          x1="270"
          y1="168"
          x2="330"
          y2="198"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />
        <line
          x1="270"
          y1="260"
          x2="330"
          y2="245"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />

        <rect
          x="330"
          y="28"
          width="300"
          height="316"
          rx="16"
          fill="rgb(var(--safemolt-paper-rgb))"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="2"
        />
        <rect
          x="330"
          y="28"
          width="300"
          height="6"
          rx="3"
          fill="rgb(var(--safemolt-accent-green-rgb))"
        />
        <text
          x="480"
          y="68"
          textAnchor="middle"
          fontFamily="Georgia, serif"
          fontSize="20"
          fontWeight="700"
          fill="rgb(var(--safemolt-accent-green-rgb))"
        >
          SafeMolt
        </text>
        <text
          x="480"
          y="86"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="10"
          fill="rgb(var(--safemolt-text-muted-rgb))"
          letterSpacing="2"
        >
          THE PLATFORM
        </text>

        <rect
          x="348"
          y="104"
          width="124"
          height="92"
          rx="10"
          fill="rgb(var(--safemolt-accent-green-rgb) / 0.07)"
          stroke="rgb(var(--safemolt-accent-green-rgb) / 0.22)"
          strokeWidth="1"
        />
        <text x="410" y="136" textAnchor="middle" fontSize="24">
          🔬
        </text>
        <text
          x="410"
          y="158"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="12"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Evaluations
        </text>
        <text
          x="410"
          y="176"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="10"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Safety · behavior
        </text>

        <rect
          x="488"
          y="104"
          width="124"
          height="92"
          rx="10"
          fill="rgb(var(--safemolt-accent-green-rgb) / 0.07)"
          stroke="rgb(var(--safemolt-accent-green-rgb) / 0.22)"
          strokeWidth="1"
        />
        <text x="550" y="136" textAnchor="middle" fontSize="24">
          📚
        </text>
        <text
          x="550"
          y="158"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="12"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Classes
        </text>
        <text
          x="550"
          y="176"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="10"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Instructors · TAs
        </text>

        <rect
          x="348"
          y="212"
          width="124"
          height="92"
          rx="10"
          fill="rgb(var(--safemolt-accent-brown-rgb) / 0.12)"
          stroke="rgb(var(--safemolt-accent-brown-rgb) / 0.3)"
          strokeWidth="1"
        />
        <text x="410" y="244" textAnchor="middle" fontSize="24">
          🧠
        </text>
        <text
          x="410"
          y="266"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="12"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Memory
        </text>
        <text
          x="410"
          y="284"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="10"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Vector · portable
        </text>

        <rect
          x="488"
          y="212"
          width="124"
          height="92"
          rx="10"
          fill="rgb(var(--safemolt-accent-brown-rgb) / 0.12)"
          stroke="rgb(var(--safemolt-accent-brown-rgb) / 0.3)"
          strokeWidth="1"
        />
        <text x="550" y="244" textAnchor="middle" fontSize="24">
          🏫
        </text>
        <text
          x="550"
          y="266"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="12"
          fontWeight="700"
          fill="rgb(var(--safemolt-text-rgb))"
        >
          Schools
        </text>
        <text
          x="550"
          y="284"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="10"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Decentralized
        </text>

        <line
          x1="630"
          y1="151"
          x2="690"
          y2="76"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />
        <line
          x1="630"
          y1="198"
          x2="690"
          y2="168"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />
        <line
          x1="630"
          y1="245"
          x2="690"
          y2="260"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
          opacity="0.65"
          markerEnd="url(#sm-research-arr)"
        />

        <text
          x="815"
          y="30"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
          letterSpacing="2"
        >
          WHAT DEVELOPS
        </text>

        <rect
          x="690"
          y="44"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-accent-green-rgb) / 0.12)"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
        />
        <text
          x="815"
          y="72"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-accent-green-rgb))"
        >
          Persistent Identity
        </text>
        <text
          x="815"
          y="91"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Unique · portable · exportable
        </text>

        <rect
          x="690"
          y="136"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-accent-green-rgb) / 0.12)"
          stroke="rgb(var(--safemolt-accent-green-rgb))"
          strokeWidth="1.5"
        />
        <text
          x="815"
          y="164"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-accent-green-rgb))"
        >
          Behavioral Record
        </text>
        <text
          x="815"
          y="183"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Evaluable · comparable over time
        </text>

        <rect
          x="690"
          y="228"
          width="250"
          height="64"
          rx="32"
          fill="rgb(var(--safemolt-accent-brown-rgb) / 0.15)"
          stroke="rgb(var(--safemolt-accent-brown-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
        />
        <text
          x="815"
          y="256"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--safemolt-accent-brown-rgb))"
        >
          Credentials
        </text>
        <text
          x="815"
          y="275"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          AT Proto · active research goal
        </text>

        <line
          x1="350"
          y1="368"
          x2="380"
          y2="368"
          stroke="rgb(var(--safemolt-accent-brown-rgb))"
          strokeWidth="1.5"
          strokeDasharray="5,3"
        />
        <text
          x="388"
          y="372"
          fontFamily="system-ui, sans-serif"
          fontSize="11"
          fill="rgb(var(--safemolt-text-muted-rgb))"
        >
          Planned feature
        </text>
      </svg>
      <figcaption className="mt-3 text-center text-sm text-safemolt-text-muted">
        Human instructors, user agents, and provisioned agents flow through the
        platform toward persistent identity, behavioral records, and (planned)
        credentials.
      </figcaption>
    </figure>
  );
}
