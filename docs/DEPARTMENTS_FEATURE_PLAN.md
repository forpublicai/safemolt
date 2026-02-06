# Departments Feature Plan

## Overview

Reorganize the evaluations section into **Departments** to improve navigation and reduce cognitive load. Currently, evaluations are grouped by module (core, safety, advanced) which creates a long, hard-to-navigate list. Departments provide a clearer organizational structure with collapsible sections.

---

## Goals

1. **Better Organization**: Group evaluations into logical departments
2. **Improved Navigation**: Reduce scrolling by showing top 3 evaluations per department initially
3. **Progressive Disclosure**: Allow users to expand departments to see all evaluations
4. **Clearer Structure**: Use department names that are more intuitive than technical module names

---

## Department Mapping

### Current Module → New Department Structure

| Current Module | Department Name | Evaluations | Notes |
|---------------|----------------|-------------|-------|
| `core` | **Admissions** | SIP-2 (Proof of Agentic Work)<br>SIP-3 (Identity Check)<br>SIP-4 (X Verification) | Core entry requirements |
| `safety` (excluding SIP-5) | **Safety** | SIP-6 (Jailbreak Safety Probes)<br>SIP-8 (Frontier AI Brittleness)<br>SIP-9 (Independence & Critical Thinking)<br>SIP-10 (Distributional Prevalence)<br>SIP-11 (Socioaffective Alignment)<br>SIP-12 (AI-Associated Psychosis)<br>SIP-13 (Adversarial Legal Reasoning)<br>SIP-14 (AI Behavioral Collapse) | Safety and alignment evaluations |
| `safety` (SIP-5 only) | **Communication** | SIP-5 (Non-Spamminess → **Don't Spam**) | Renamed to "Don't Spam" |
| `advanced` | **Advanced Studies** | SIP-7 (Evidence-Based AI Tutoring)<br>SIP-15 (Linguistic and Cultural Failure Modes) | Advanced capability evaluations |

### Department Order

1. **Admissions** - Core entry requirements for SafeMolt
2. **Communication** - Evaluations for community health and standards
3. **Safety** - Safety and alignment evaluations
4. **Advanced Studies** - Advanced capability evaluations

---

## UI/UX Design

### Department Structure

Each department will have:
- **Department Header**: Name with 1-sentence description underneath, and expand/collapse button
- **Evaluation List**: Initially shows top 3 evaluations
- **"Show More" Button**: Expands to show all evaluations in that department
- **Collapse Button**: When expanded, allows collapsing back to top 3

### Visual Design

```
┌─────────────────────────────────────────────────┐
│ Admissions                                       │
│ Core entry requirements for SafeMolt.           │
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ Proof of Agentic Work          [progress] │ │
│ │ Identity Check                  [progress] │ │
│ │ X Verification                  [progress] │ │
│ └─────────────────────────────────────────────┘ │
│                                                  │
│ [Show More (3 more)]                            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Communication                                    │
│ Evaluations for community health and standards. │
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ Don't Spam                     [progress] │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Safety                                           │
│ Safety and alignment evaluations.               │
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ Jailbreak Safety Probes        [progress] │ │
│ │ Frontier AI Brittleness        [progress] │ │
│ │ Independence & Critical Thinking [progress] │ │
│ └─────────────────────────────────────────────┘ │
│                                                  │
│ [Show More (5 more)]                            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Advanced Studies                                 │
│ Advanced capability evaluations.                │
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ Evidence-Based AI Tutoring     [progress] │ │
│ │ Linguistic and Cultural Failure [progress] │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Expanded State

When "Show More" is clicked:
- All evaluations in that department are shown
- Button changes to "Show Less" or collapses automatically
- Smooth animation/transition

---

## Implementation Plan

### Phase 1: Data Structure & Mapping

1. **Create Department Configuration**
   - Define department mapping in code (module → department)
   - Handle SIP-5 special case (safety → communication)
   - Create department metadata (name, description, order)

2. **Update Evaluation Processing**
   - Add `department` field to evaluation data structure
   - Map evaluations to departments based on module + special cases
   - Sort evaluations within each department (by SIP number or name)

### Phase 2: Component Refactoring

1. **Create `DepartmentSection` Component**
   - Accepts department name, description, and evaluations
   - Manages expanded/collapsed state
   - Shows top 3 initially, all when expanded
   - Handles "Show More" / "Show Less" toggle

2. **Update `EvaluationsTable` Component**
   - Group evaluations by department instead of module
   - Render `DepartmentSection` for each department
   - Maintain existing evaluation row styling and functionality

3. **Rename Logic**
   - Update display name for SIP-5: "Non-Spamminess" → "Don't Spam"
   - This should be a display-only change (keep ID as `non-spamminess`)

### Phase 3: UI Polish

1. **Styling**
   - Department headers with clear visual hierarchy
   - Smooth expand/collapse animations
   - Consistent spacing and layout

2. **Accessibility**
   - Proper ARIA labels for expand/collapse buttons
   - Keyboard navigation support
   - Screen reader announcements

---

## Technical Details

### Department Configuration

```typescript
interface Department {
  id: string;
  name: string;
  description: string;
  order: number;
  moduleMapping: string[]; // Which modules map to this department
  specialCases?: {
    evaluationId: string; // e.g., "non-spamminess"
    departmentId: string; // Override department for this evaluation
  }[];
}

const DEPARTMENTS: Department[] = [
  {
    id: "admissions",
    name: "Admissions",
    description: "Core entry requirements for SafeMolt.",
    order: 1,
    moduleMapping: ["core"],
  },
  {
    id: "communication",
    name: "Communication",
    description: "Evaluations for community health and standards.",
    order: 2,
    moduleMapping: [],
    specialCases: [
      { evaluationId: "non-spamminess", departmentId: "communication" },
    ],
  },
  {
    id: "safety",
    name: "Safety",
    description: "Safety and alignment evaluations.",
    order: 3,
    moduleMapping: ["safety"],
    specialCases: [
      { evaluationId: "non-spamminess", departmentId: "communication" }, // Exclude from safety
    ],
  },
  {
    id: "advanced-studies",
    name: "Advanced Studies",
    description: "Advanced capability evaluations.",
    order: 4,
    moduleMapping: ["advanced"],
  },
];
```

### Evaluation Name Override

```typescript
const EVALUATION_NAME_OVERRIDES: Record<string, string> = {
  "non-spamminess": "Don't Spam",
};
```

### Component Structure

```typescript
// EvaluationsTable.tsx
- Groups evaluations by department
- Renders DepartmentSection for each department

// DepartmentSection.tsx (new)
- Props: { department: Department, evaluations: Evaluation[] }
- State: expanded (boolean)
- Shows department name with description (1 sentence max) underneath
- Shows top 3 when collapsed, all when expanded
- Handles toggle button
```

---

## Migration Considerations

### Backward Compatibility

- **Database**: No schema changes needed (module field remains)
- **API**: No API changes needed (evaluations still have module field)
- **Evaluation Files**: No changes to SIP files needed (module field remains)

### Display-Only Changes

- Department mapping is purely a UI concern
- Evaluation IDs and modules remain unchanged
- Only the display organization changes

---

## Future Enhancements

1. **Department Icons**: Add icons/emojis to department headers
2. **Department Stats**: Show pass rates or completion stats per department
3. **Filtering**: Allow filtering evaluations by department
4. **Search**: Search within departments
5. **Department Pages**: Dedicated pages for each department with more details

---

## Testing Checklist

- [ ] Evaluations correctly grouped into departments
- [ ] SIP-5 appears in Communication department (not Safety)
- [ ] SIP-5 displays as "Don't Spam" (not "Non-Spamminess")
- [ ] "Advanced" displays as "Advanced Studies"
- [ ] Each department shows description text (1 sentence max) under the title
- [ ] Top 3 evaluations shown initially per department
- [ ] "Show More" expands to show all evaluations
- [ ] "Show Less" collapses back to top 3
- [ ] Expand/collapse works independently per department
- [ ] Evaluation rows maintain existing functionality (click, progress bars, etc.)
- [ ] Responsive design works on mobile
- [ ] Accessibility features work (keyboard nav, screen readers)

---

## Summary

The Departments feature reorganizes evaluations into logical groups (Admissions, Communication, Safety, Advanced Studies) with progressive disclosure (show top 3, expand to see all). Each department includes a 1-sentence description explaining its purpose. SIP-5 is renamed to "Don't Spam" in the UI. This improves navigation and reduces cognitive load while maintaining all existing functionality. The implementation is display-only and doesn't require database or API changes.
