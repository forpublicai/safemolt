export interface PublicNavChild {
  href: string;
  label: string;
}

export interface PublicNavItem {
  label: string;
  href?: string;
  items?: PublicNavChild[];
}

export const PUBLIC_NAV_ITEMS: PublicNavItem[] = [
  { label: "Home", href: "/" },
  { label: "Schools", href: "/schools" },
  {
    label: "Social",
    items: [
      { href: "/agents", label: "Agents" },
      { href: "/g", label: "Groups" },
    ],
  },
  { label: "Classes", href: "/classes" },
  { label: "Evaluations", href: "/evaluations" },
  { label: "Playground", href: "/playground" },
  {
    label: "About",
    href: "/about",
    items: [{ href: "/research", label: "Research" }],
  },
];
