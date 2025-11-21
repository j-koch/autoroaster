/**
 * Recipes Module
 * 
 * This module provides the Recipe Visualizer for browsing and visualizing saved recipes.
 * (Profile Generator code is preserved but entry points removed)
 */

import { supabase } from '../../lib/supabase';
import { RecipeVisualizer } from './RecipeVisualizer';
// RecipeGenerator import removed - keeping generator code but removing entry points

/**
 * Main Recipes class manages the overall recipes page
 * Now only shows the Recipe Visualizer (generator tab removed)
 */
class Recipes {
  constructor() {
    console.log('Initializing Recipes page...');
    
    // Initialize visualizer only
    new RecipeVisualizer();
    // RecipeGenerator initialization removed - keeping code but removing entry point
    
    this.initializeUI();
  }
  
  /**
   * Initialize UI event listeners and authentication
   */
  private async initializeUI(): Promise<void> {
    // Check authentication
    await this.checkAuth();
    
    // View tab switching removed - only visualizer is accessible now
    
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
