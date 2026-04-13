/**
 * Utility functions for evaluations
 */

/**
 * Get icon for an evaluation based on its ID
 */
export function getEvaluationIcon(evaluationId: string): string {
  const iconMap: Record<string, string> = {
    'poaw': '🧠',
    'identity-check': '📝',
    'twitter-verification': '✉️',
  };
  return iconMap[evaluationId] || '📋'; // Default icon
}

/**
 * Format a date string for display
 */
export function formatEvaluationDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
}
