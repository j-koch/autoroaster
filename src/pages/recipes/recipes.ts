/**
 * Recipes Module
 * 
 * This module provides two main features:
 * 1. Recipe Visualizer - Browse and visualize saved recipes (similar to roast history)
 * 2. Profile Generator - Create new recipes using spline-based control input editor
 */

import { supabase } from '../../lib/supabase';
import { RecipeVisualizer } from './RecipeVisualizer';
import { RecipeGenerator } from './RecipeGenerator';

/**
 * Main Recipes class manages the overall recipes page
 * Handles tab switching between visualizer and generator
 */
class Recipes {
  constructor() {
    console.log('Initializing Recipes page...');
    
    // Initialize sub-modules
    new RecipeVisualizer();
    new RecipeGenerator();
    
    this.initializeUI();
  }
  
  /**
   * Initialize UI event listeners and authentication
   */
  private async initializeUI(): Promise<void> {
    // Check authentication
    await this.checkAuth();
    
    // Set up view tabs
    const viewTabs = document.querySelectorAll('.view-tab');
    viewTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLButtonElement;
        const view = target.getAttribute('data-view') as 'visualizer' | 'generator';
        if (view) {
          this.switchView(view);
        }
      });
    });
    
    // Set up sign out button
    const signoutBtn = document.getElementById('signout-btn');
    if (signoutBtn) {
      signoutBtn.addEventListener('click', () => this.handleSignOut());
    }
  }
  
  /**
   * Check if user is authenticated, redirect to login if not
   */
  private async checkAuth(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      window.location.href = './login.html';
      return;
    }
    
    // Display user email
    const userEmailSpan = document.getElementById('user-email');
    if (userEmailSpan && session.user.email) {
      userEmailSpan.textContent = session.user.email;
    }
  }
  
  /**
   * Switch between visualizer and generator views
   * @param view - The view to switch to
   */
  private switchView(view: 'visualizer' | 'generator'): void {
    // Update tab active states
    const tabs = document.querySelectorAll('.view-tab');
    tabs.forEach(tab => {
      const tabView = tab.getAttribute('data-view');
      if (tabView === view) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
    
    // Update view visibility
    const visualizerView = document.getElementById('visualizer-view');
    const generatorView = document.getElementById('generator-view');
    
    if (view === 'visualizer') {
      visualizerView?.classList.add('active');
      generatorView?.classList.remove('active');
    } else {
      visualizerView?.classList.remove('active');
      generatorView?.classList.add('active');
    }
    
    console.log(`Switched to ${view} view`);
  }
  
  /**
   * Handle user sign out
   */
  private async handleSignOut(): Promise<void> {
    try {
      await supabase.auth.signOut();
      window.location.href = './login.html';
    } catch (error) {
      console.error('Sign out error:', error);
    }
  }
  
  /**
   * Display message to user
   * @param message - Message text to display
   * @param type - Message type (error, success, info)
   */
  showMessage(message: string, type: 'error' | 'success' | 'info' = 'info'): void {
    const messageDiv = document.getElementById('message');
    if (messageDiv) {
      messageDiv.textContent = message;
      messageDiv.className = `message ${type}`;
      messageDiv.style.display = 'block';
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 5000);
    }
  }
}

// Initialize the recipes page when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new Recipes();
});
