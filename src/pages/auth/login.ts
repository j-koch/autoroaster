/**
 * Login page functionality
 * 
 * This module handles user authentication (sign in and sign up) using Supabase.
 * It manages form validation, UI state, and redirects users appropriately.
 */

import { supabase } from '../../lib/supabase';

// ========================================
// DOM ELEMENTS
// ========================================
const messageDiv = document.getElementById('message') as HTMLDivElement;
const authTabs = document.querySelectorAll('.auth-tab') as NodeListOf<HTMLButtonElement>;
const authForms = document.querySelectorAll('.auth-form') as NodeListOf<HTMLFormElement>;
const switchTabLinks = document.querySelectorAll('.switch-tab') as NodeListOf<HTMLAnchorElement>;

const signinForm = document.getElementById('signin-form') as HTMLFormElement;
const signupForm = document.getElementById('signup-form') as HTMLFormElement;
const signinButton = document.getElementById('signin-button') as HTMLButtonElement;
const signupButton = document.getElementById('signup-button') as HTMLButtonElement;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Display a message to the user
 * @param text - Message text to display
 * @param type - Message type: 'error', 'success', or 'info'
 */
function showMessage(text: string, type: 'error' | 'success' | 'info'): void {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    // Auto-hide success messages after 5 seconds
    if (type === 'success') {
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    }
}

/**
 * Hide the message display
 */
function hideMessage(): void {
    messageDiv.style.display = 'none';
}

/**
 * Show loading state on a button
 * @param button - Button element to show loading state
 * @param loading - Whether to show or hide loading state
 */
function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
    if (loading) {
        button.disabled = true;
        button.innerHTML = button.textContent + '<span class="loading-spinner"></span>';
    } else {
        button.disabled = false;
        button.innerHTML = button.textContent!.replace(/<span.*?<\/span>/, '');
    }
}

// ========================================
// TAB SWITCHING
// ========================================

/**
 * Switch between Sign In and Sign Up tabs
 * @param tabName - 'signin' or 'signup'
 */
function switchTab(tabName: 'signin' | 'signup'): void {
    // Update tab buttons
    authTabs.forEach(tab => {
        if (tab.dataset.tab === tabName) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    // Update forms
    authForms.forEach(form => {
        if (form.id === `${tabName}-form`) {
            form.classList.add('active');
        } else {
            form.classList.remove('active');
        }
    });
    
    // Clear any messages
    hideMessage();
}

// Add click handlers for tab buttons
authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab as 'signin' | 'signup');
    });
});

// Add click handlers for switch tab links
switchTabLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        switchTab(link.dataset.tab as 'signin' | 'signup');
    });
});

// ========================================
// AUTHENTICATION FUNCTIONS
// ========================================

/**
 * Handle user sign in
 * @param e - Form submit event
 */
async function handleSignIn(e: Event): Promise<void> {
    e.preventDefault();
    
    const email = (document.getElementById('signin-email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('signin-password') as HTMLInputElement).value;
    
    if (!email || !password) {
        showMessage('Please enter both email and password', 'error');
        return;
    }
    
    setButtonLoading(signinButton, true);
    hideMessage();
    
    try {
        // Attempt to sign in with Supabase
        const { error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });
        
        if (error) {
            throw error;
        }
        
        // Sign in successful - redirect to dashboard
        showMessage('Sign in successful! Redirecting...', 'success');
        
        // Redirect after a short delay
        setTimeout(() => {
            window.location.href = '/dashboard.html';
        }, 1000);
        
    } catch (error: any) {
        console.error('Sign in error:', error);
        showMessage(error.message || 'Failed to sign in. Please check your credentials.', 'error');
        setButtonLoading(signinButton, false);
    }
}

/**
 * Handle user sign up
 * @param e - Form submit event
 */
async function handleSignUp(e: Event): Promise<void> {
    e.preventDefault();
    
    const email = (document.getElementById('signup-email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('signup-password') as HTMLInputElement).value;
    const passwordConfirm = (document.getElementById('signup-password-confirm') as HTMLInputElement).value;
    
    // Validation
    if (!email || !password || !passwordConfirm) {
        showMessage('Please fill in all fields', 'error');
        return;
    }
    
    if (password.length < 6) {
        showMessage('Password must be at least 6 characters long', 'error');
        return;
    }
    
    if (password !== passwordConfirm) {
        showMessage('Passwords do not match', 'error');
        return;
    }
    
    setButtonLoading(signupButton, true);
    hideMessage();
    
    try {
        // Attempt to sign up with Supabase
        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: password,
            options: {
                emailRedirectTo: `${window.location.origin}/dashboard.html`
            }
        });
        
        if (error) {
            throw error;
        }
        
        // Check if email confirmation is required
        if (data.user && !data.session) {
            showMessage('Sign up successful! Please check your email to confirm your account.', 'info');
            setButtonLoading(signupButton, false);
        } else {
            // Auto sign-in successful - redirect to dashboard
            showMessage('Account created successfully! Redirecting...', 'success');
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 1000);
        }
        
    } catch (error: any) {
        console.error('Sign up error:', error);
        showMessage(error.message || 'Failed to create account. Please try again.', 'error');
        setButtonLoading(signupButton, false);
    }
}

// ========================================
// SESSION CHECK
// ========================================

/**
 * Check if user is already signed in
 * If yes, redirect to dashboard
 */
async function checkExistingSession(): Promise<void> {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session) {
            // User is already signed in - redirect to dashboard
            window.location.href = '/dashboard.html';
        }
    } catch (error) {
        console.error('Session check error:', error);
        // Continue to show login page if there's an error
    }
}

// ========================================
// EVENT LISTENERS
// ========================================

signinForm.addEventListener('submit', handleSignIn);
signupForm.addEventListener('submit', handleSignUp);

// ========================================
// INITIALIZATION
// ========================================

// Check for existing session on page load
checkExistingSession();
