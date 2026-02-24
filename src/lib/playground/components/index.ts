/**
 * Component Registry
 * Central export for all playground components.
 */
import { memoryComponent } from './memory-component';
import { reasoningComponent } from './reasoning-component';
import type { Component, ComponentRegistry } from '../types';

export { memoryComponent } from './memory-component';
export { reasoningComponent } from './reasoning-component';

/**
 * Get all available components
 */
export function getAllComponents(): Component[] {
    return [
        memoryComponent,
        reasoningComponent,
    ];
}

/**
 * Get component by ID
 */
export function getComponentById(id: string): Component | undefined {
    const components = getAllComponents();
    return components.find(c => c.id === id);
}

/**
 * Default component registry with all enabled components
 */
export function createDefaultRegistry(): ComponentRegistry {
    const registry: ComponentRegistry = {};
    
    for (const component of getAllComponents()) {
        registry[component.id] = {
            component,
            enabled: true,
        };
    }
    
    return registry;
}
