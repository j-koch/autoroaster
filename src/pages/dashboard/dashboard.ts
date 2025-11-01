/**
 * Dashboard page functionality
 * 
 * This module handles:
 * - User authentication and session management
 * - Roast file uploads and metadata management
 * - Roast history display and filtering/sorting
 * - Roast editing and deletion operations
 * - File downloads from Supabase Storage
 * - Roast visualization (single and group)
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import { parseAlogFile, calculateRateOfRise, type ParsedRoastData } from '../../data/alogParser';
import * as Plotly from 'plotly.js-dist-min';
import { Testbed } from './testbed';

// ========================================
// TYPES
// ========================================

/**
 * Roast metadata stored in the database
 * This structure represents a single roast record with all its associated data
 */
interface Roast {
    id: string;
    user_id: string;
    filename: string;
    file_url: string;  // Path within the storage bucket (e.g., 'user_id/timestamp.alog')
    upload_date: string;
    roaster: string | null;
    origin: string | null;
    variety: string | null;
    roast_date: string | null;
    process: string | null;
    charge_mass: number | null;
    final_mass: number | null;
    ambient_temp: number | null;
    relative_humidity: number | null;
}

// ========================================
// GLOBAL STATE
// ========================================
let currentUser: User | null = null;

// Filtering and sorting state
let allRoasts: Roast[] = [];  // Cache of all roasts (unfiltered)
let filteredRoasts: Roast[] = [];  // Current filtered/sorted roasts
let selectedRoastIds: Set<string> = new Set();  // Set of selected roast IDs

// Parsed roast data cache (for visualization)
const roastDataCache: Map<string, ParsedRoastData> = new Map();

// Currently highlighted roast in visualization (for chart-to-table highlighting)
let highlightedRoastId: string | null = null;

// ========================================
// DOM ELEMENTS
// ========================================
const messageDiv = document.getElementById('message') as HTMLDivElement;
const userEmailSpan = document.getElementById('user-email') as HTMLSpanElement;
const signoutBtn = document.getElementById('signout-btn') as HTMLButtonElement;

const viewTabs = document.querySelectorAll('.view-tab') as NodeListOf<HTMLButtonElement>;
const views = document.querySelectorAll('.view') as NodeListOf<HTMLDivElement>;

const uploadForm = document.getElementById('upload-form') as HTMLFormElement;
const uploadBtn = document.getElementById('upload-btn') as HTMLButtonElement;

const historyLoading = document.getElementById('history-loading') as HTMLDivElement;
const historyEmpty = document.getElementById('history-empty') as HTMLDivElement;
const historyTableContainer = document.getElementById('history-table-container') as HTMLDivElement;
const roastTableBody = document.getElementById('roast-table-body') as HTMLTableSectionElement;

// Edit modal elements
const editModal = document.getElementById('edit-modal') as HTMLDivElement;
const editForm = document.getElementById('edit-form') as HTMLFormElement;
const editModalClose = document.getElementById('edit-modal-close') as HTMLButtonElement;
const editCancelBtn = document.getElementById('edit-cancel-btn') as HTMLButtonElement;
const editSaveBtn = document.getElementById('edit-save-btn') as HTMLButtonElement;

// Filter and sort elements
const filterControls = document.getElementById('filter-controls') as HTMLDivElement;
const filterOrigin = document.getElementById('filter-origin') as HTMLInputElement;
const filterVariety = document.getElementById('filter-variety') as HTMLInputElement;
const filterRoaster = document.getElementById('filter-roaster') as HTMLInputElement;
const filterProcess = document.getElementById('filter-process') as HTMLSelectElement;
const sortBy = document.getElementById('sort-by') as HTMLSelectElement;
const clearFiltersBtn = document.getElementById('clear-filters') as HTMLButtonElement;

// Selection elements
const visualizeSelectedBtn = document.getElementById('visualize-selected') as HTMLButtonElement;
const selectionCount = document.getElementById('selection-count') as HTMLSpanElement;
const selectAllCheckbox = document.getElementById('select-all') as HTMLInputElement;
const visualizeActions = document.getElementById('visualize-actions') as HTMLDivElement;

// Visualization panel elements
const vizPanelTitle = document.getElementById('viz-panel-title') as HTMLHeadingElement;
const vizPanelLoading = document.getElementById('viz-panel-loading') as HTMLDivElement;
const vizPanelCharts = document.getElementById('viz-panel-charts') as HTMLDivElement;
const vizPanelEmpty = document.getElementById('viz-panel-empty') as HTMLDivElement;
const tempChart = document.getElementById('temp-chart') as HTMLDivElement;
const controlChart = document.getElementById('control-chart') as HTMLDivElement;

// Note: Visualization modal elements removed - now using inline panel instead

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
    
    // Auto-hide messages after 5 seconds
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 5000);
    
    // Scroll to top to show message
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Format date string for display
 * @param dateString - ISO date string (YYYY-MM-DD)
 * @returns Formatted date string (e.g., "Oct 24, 2025")
 * 
 * Note: We parse the date components manually to avoid timezone conversion issues.
 * When using new Date("2025-10-31"), JavaScript interprets it as UTC midnight,
 * which then gets converted to local timezone, potentially showing the wrong date.
 */
function formatDate(dateString: string | null): string {
    if (!dateString) return 'N/A';
    
    // Parse date components manually to avoid timezone issues
    // Expected format: YYYY-MM-DD
    const parts = dateString.split('-');
    if (parts.length !== 3) return 'N/A';
    
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed in Date constructor
    const day = parseInt(parts[2], 10);
    
    // Create date in local timezone (not UTC)
    const date = new Date(year, month, day);
    
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

/**
 * Format timestamp for display
 * @param timestamp - ISO timestamp string
 * @returns Formatted timestamp string (e.g., "Oct 24, 2025, 10:30 AM")
 */
function formatTimestamp(timestamp: string | null): string {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ========================================
// VIEW SWITCHING
// ========================================

/**
 * Switch between views (History and Upload)
 * @param viewName - 'history' or 'upload'
 */
function switchView(viewName: string): void {
    // Update tab buttons
    viewTabs.forEach(tab => {
        if (tab.dataset.view === viewName) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    // Update views
    views.forEach(view => {
        if (view.id === `${viewName}-view`) {
            view.classList.add('active');
        } else {
            view.classList.remove('active');
        }
    });
    
    // Refresh history when switching to it
    if (viewName === 'history') {
        loadRoastHistory();
    }
}

// Add click handlers for view tabs
viewTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        switchView(tab.dataset.view!);
    });
});

// ========================================
// AUTHENTICATION
// ========================================

/**
 * Check if user is authenticated
 * Redirect to login if not
 */
async function checkAuth(): Promise<void> {
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error || !session) {
            // Not authenticated - redirect to login
            window.location.href = '/login.html';
            return;
        }
        
        // Store current user
        currentUser = session.user;
        
        // Display user email
        userEmailSpan.textContent = currentUser.email!;
        
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login.html';
    }
}

/**
 * Handle sign out
 */
async function handleSignOut(): Promise<void> {
    try {
        const { error } = await supabase.auth.signOut();
        
        if (error) {
            throw error;
        }
        
        // Redirect to login page
        window.location.href = '/login.html';
        
    } catch (error: any) {
        console.error('Sign out error:', error);
        showMessage('Failed to sign out. Please try again.', 'error');
    }
}

signoutBtn.addEventListener('click', handleSignOut);

// ========================================
// ROAST HISTORY
// ========================================

/**
 * Load and display roast history from database with filtering support
 */
async function loadRoastHistory(): Promise<void> {
    historyLoading.style.display = 'block';
    historyEmpty.style.display = 'none';
    historyTableContainer.style.display = 'none';
    filterControls.style.display = 'none';
    
    try {
        const { data: roasts, error } = await supabase
            .from('roasts')
            .select('*')
            .eq('user_id', currentUser!.id);
        
        if (error) {
            throw error;
        }
        
        historyLoading.style.display = 'none';
        
        if (!roasts || roasts.length === 0) {
            historyEmpty.style.display = 'block';
            return;
        }
        
        // Store all roasts and apply filters
        allRoasts = roasts as Roast[];
        filterControls.style.display = 'block';
        visualizeActions.style.display = 'block';
        historyTableContainer.style.display = 'block';
        applyFiltersAndSort();
        
    } catch (error: any) {
        console.error('Load roasts error:', error);
        historyLoading.style.display = 'none';
        showMessage('Failed to load roast history. Please try refreshing the page.', 'error');
    }
}

/**
 * Download a roast file from Supabase Storage
 * @param fileUrl - Storage URL path (e.g., 'user_id/filename.alog')
 * @param filename - Original filename
 */
async function downloadRoastFile(fileUrl: string, filename: string): Promise<void> {
    try {
        // Download file from Supabase Storage
        // The fileUrl is the path within the bucket (e.g., 'user_id/timestamp.alog')
        const { data, error } = await supabase.storage
            .from('roast-data')
            .download(fileUrl);
        
        if (error) {
            throw error;
        }
        
        // Create a download link and trigger it
        const blob = new Blob([data], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showMessage('File downloaded successfully!', 'success');
        
    } catch (error: any) {
        console.error('Download error:', error);
        showMessage('Failed to download file. Please try again.', 'error');
    }
}

// ========================================
// UPLOAD ROAST
// ========================================

/**
 * Handle roast upload form submission
 * Uploads the file to Supabase Storage and stores metadata in the database
 * @param e - Form submit event
 */
async function handleUpload(e: Event): Promise<void> {
    e.preventDefault();
    
    // Get form values
    const fileInput = document.getElementById('roast-file') as HTMLInputElement;
    const file = fileInput.files?.[0];
    
    if (!file) {
        showMessage('Please select a file to upload', 'error');
        return;
    }
    
    // Validate file extension
    if (!file.name.endsWith('.alog')) {
        showMessage('Please select a valid .alog file', 'error');
        return;
    }
    
    const formData = {
        roaster: (document.getElementById('roaster') as HTMLInputElement).value.trim() || null,
        origin: (document.getElementById('origin') as HTMLInputElement).value.trim(),
        variety: (document.getElementById('variety') as HTMLInputElement).value.trim(),
        roastDate: (document.getElementById('roast-date') as HTMLInputElement).value,
        process: (document.getElementById('process') as HTMLSelectElement).value,
        chargeMass: parseFloat((document.getElementById('charge-mass') as HTMLInputElement).value),
        finalMass: parseFloat((document.getElementById('final-mass') as HTMLInputElement).value),
        ambientTemp: parseFloat((document.getElementById('ambient-temp') as HTMLInputElement).value),
        relativeHumidity: parseFloat((document.getElementById('relative-humidity') as HTMLInputElement).value)
    };
    
    // Disable submit button and show loading
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    
    try {
        // Generate unique filename with timestamp
        // Storage path: user_id/timestamp.alog
        const timestamp = Date.now();
        const storagePath = `${currentUser!.id}/${timestamp}.alog`;
        
        // Upload file to Supabase Storage
        const { error: storageError } = await supabase.storage
            .from('roast-data')
            .upload(storagePath, file, {
                cacheControl: '3600',
                upsert: false
            });
        
        if (storageError) {
            throw storageError;
        }
        
        // Insert metadata into database
        const { error: dbError } = await supabase
            .from('roasts')
            .insert([
                {
                    user_id: currentUser!.id,
                    filename: file.name,
                    file_url: storagePath,  // Store the path within the bucket
                    upload_date: new Date().toISOString(),
                    roaster: formData.roaster,
                    origin: formData.origin,
                    variety: formData.variety,
                    roast_date: formData.roastDate,
                    process: formData.process,
                    charge_mass: formData.chargeMass,
                    final_mass: formData.finalMass,
                    ambient_temp: formData.ambientTemp,
                    relative_humidity: formData.relativeHumidity
                }
            ]);
        
        if (dbError) {
            // If database insert fails, try to delete the uploaded file
            await supabase.storage
                .from('roast-data')
                .remove([storagePath]);
            
            throw dbError;
        }
        
        // Success! Show message and reset form
        showMessage('Roast uploaded successfully!', 'success');
        uploadForm.reset();
        
        // Switch to history view to show the new roast
        switchView('history');
        
    } catch (error: any) {
        console.error('Upload error:', error);
        showMessage(error.message || 'Failed to upload roast. Please try again.', 'error');
    } finally {
        // Re-enable submit button
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload Roast';
    }
}

uploadForm.addEventListener('submit', handleUpload);

// ========================================
// EDIT ROAST
// ========================================

/**
 * Open the edit modal and populate with roast data
 * @param roast - Roast object to edit
 */
function openEditModal(roast: Roast): void {
    // Populate form fields with roast data
    (document.getElementById('edit-roast-id') as HTMLInputElement).value = roast.id;
    (document.getElementById('edit-roaster') as HTMLInputElement).value = roast.roaster || '';
    (document.getElementById('edit-origin') as HTMLInputElement).value = roast.origin || '';
    (document.getElementById('edit-variety') as HTMLInputElement).value = roast.variety || '';
    (document.getElementById('edit-roast-date') as HTMLInputElement).value = roast.roast_date || '';
    (document.getElementById('edit-process') as HTMLSelectElement).value = roast.process || '';
    (document.getElementById('edit-charge-mass') as HTMLInputElement).value = roast.charge_mass?.toString() || '';
    (document.getElementById('edit-final-mass') as HTMLInputElement).value = roast.final_mass?.toString() || '';
    (document.getElementById('edit-ambient-temp') as HTMLInputElement).value = roast.ambient_temp?.toString() || '';
    (document.getElementById('edit-relative-humidity') as HTMLInputElement).value = roast.relative_humidity?.toString() || '';
    
    // Show modal
    editModal.classList.add('active');
}

/**
 * Close the edit modal
 */
function closeEditModal(): void {
    editModal.classList.remove('active');
    editForm.reset();
}

/**
 * Handle edit form submission
 * Updates the roast metadata in the database
 * @param e - Form submit event
 */
async function handleEditSubmit(e: Event): Promise<void> {
    e.preventDefault();
    
    const roastId = (document.getElementById('edit-roast-id') as HTMLInputElement).value;
    
    const updatedData = {
        roaster: (document.getElementById('edit-roaster') as HTMLInputElement).value.trim() || null,
        origin: (document.getElementById('edit-origin') as HTMLInputElement).value.trim(),
        variety: (document.getElementById('edit-variety') as HTMLInputElement).value.trim(),
        roast_date: (document.getElementById('edit-roast-date') as HTMLInputElement).value,
        process: (document.getElementById('edit-process') as HTMLSelectElement).value,
        charge_mass: parseFloat((document.getElementById('edit-charge-mass') as HTMLInputElement).value),
        final_mass: parseFloat((document.getElementById('edit-final-mass') as HTMLInputElement).value),
        ambient_temp: parseFloat((document.getElementById('edit-ambient-temp') as HTMLInputElement).value),
        relative_humidity: parseFloat((document.getElementById('edit-relative-humidity') as HTMLInputElement).value)
    };
    
    // Disable save button and show loading
    editSaveBtn.disabled = true;
    editSaveBtn.textContent = 'Saving...';
    
    try {
        // Update roast in database
        const { error } = await supabase
            .from('roasts')
            .update(updatedData)
            .eq('id', roastId)
            .eq('user_id', currentUser!.id);  // Ensure user can only update their own roasts
        
        if (error) {
            throw error;
        }
        
        // Success! Close modal and reload history
        showMessage('Roast updated successfully!', 'success');
        closeEditModal();
        loadRoastHistory();
        
    } catch (error: any) {
        console.error('Update error:', error);
        showMessage(error.message || 'Failed to update roast. Please try again.', 'error');
    } finally {
        // Re-enable save button
        editSaveBtn.disabled = false;
        editSaveBtn.textContent = 'Save Changes';
    }
}

// Event listeners for edit modal
editForm.addEventListener('submit', handleEditSubmit);
editModalClose.addEventListener('click', closeEditModal);
editCancelBtn.addEventListener('click', closeEditModal);

// Close modal when clicking outside
editModal.addEventListener('click', (e) => {
    if (e.target === editModal) {
        closeEditModal();
    }
});

// ========================================
// DELETE ROAST
// ========================================

/**
 * Delete a roast and its associated file
 * @param roastId - UUID of the roast to delete
 * @param fileUrl - Storage URL path of the file to delete
 */
async function deleteRoast(roastId: string, fileUrl: string): Promise<void> {
    // Confirm deletion
    if (!confirm('Are you sure you want to delete this roast? This action cannot be undone.')) {
        return;
    }
    
    try {
        // Delete from database first
        const { error: dbError } = await supabase
            .from('roasts')
            .delete()
            .eq('id', roastId)
            .eq('user_id', currentUser!.id);  // Ensure user can only delete their own roasts
        
        if (dbError) {
            throw dbError;
        }
        
        // Delete file from storage
        // Note: This may fail if the file doesn't exist, but we'll continue anyway
        const { error: storageError } = await supabase.storage
            .from('roast-data')
            .remove([fileUrl]);
        
        if (storageError) {
            console.warn('Storage deletion warning:', storageError);
            // Don't throw - database record is already deleted
        }
        
        // Success! Reload history
        showMessage('Roast deleted successfully!', 'success');
        loadRoastHistory();
        
    } catch (error: any) {
        console.error('Delete error:', error);
        showMessage(error.message || 'Failed to delete roast. Please try again.', 'error');
    }
}

// ========================================
// FILTERING AND SORTING
// ========================================

/**
 * Apply filters and sorting to roasts
 */
function applyFiltersAndSort(): void {
    // Start with all roasts
    let filtered = [...allRoasts];
    
    // Apply text filters (case-insensitive)
    const originFilter = filterOrigin.value.toLowerCase().trim();
    const varietyFilter = filterVariety.value.toLowerCase().trim();
    const roasterFilter = filterRoaster.value.toLowerCase().trim();
    const processFilter = filterProcess.value;
    
    if (originFilter) {
        filtered = filtered.filter(r => 
            r.origin?.toLowerCase().includes(originFilter)
        );
    }
    
    if (varietyFilter) {
        filtered = filtered.filter(r => 
            r.variety?.toLowerCase().includes(varietyFilter)
        );
    }
    
    if (roasterFilter) {
        filtered = filtered.filter(r => 
            r.roaster?.toLowerCase().includes(roasterFilter)
        );
    }
    
    if (processFilter) {
        filtered = filtered.filter(r => r.process === processFilter);
    }
    
    // Apply sorting
    const sortOption = sortBy.value;
    filtered.sort((a, b) => {
        switch (sortOption) {
            case 'upload_date_desc':
                return new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime();
            case 'upload_date_asc':
                return new Date(a.upload_date).getTime() - new Date(b.upload_date).getTime();
            case 'roast_date_desc':
                return new Date(b.roast_date || '').getTime() - new Date(a.roast_date || '').getTime();
            case 'roast_date_asc':
                return new Date(a.roast_date || '').getTime() - new Date(b.roast_date || '').getTime();
            case 'origin_asc':
                return (a.origin || '').localeCompare(b.origin || '');
            case 'origin_desc':
                return (b.origin || '').localeCompare(a.origin || '');
            case 'charge_asc':
                // Sort by charge mass ascending (low to high)
                // Handle null values: put them at the end
                if (a.charge_mass === null && b.charge_mass === null) return 0;
                if (a.charge_mass === null) return 1;
                if (b.charge_mass === null) return -1;
                return a.charge_mass - b.charge_mass;
            case 'charge_desc':
                // Sort by charge mass descending (high to low)
                // Handle null values: put them at the end
                if (a.charge_mass === null && b.charge_mass === null) return 0;
                if (a.charge_mass === null) return 1;
                if (b.charge_mass === null) return -1;
                return b.charge_mass - a.charge_mass;
            default:
                return 0;
        }
    });
    
    // Store filtered results
    filteredRoasts = filtered;
    
    // Update display
    displayFilteredRoasts();
}

/**
 * Check if table container is scrollable and update scroll indicator
 */
function updateScrollIndicator(): void {
    const container = historyTableContainer;
    if (container && container.scrollWidth > container.clientWidth) {
        container.classList.add('has-scroll');
    } else {
        container.classList.remove('has-scroll');
    }
}

/**
 * Display filtered and sorted roasts with selection checkboxes
 */
function displayFilteredRoasts(): void {
    roastTableBody.innerHTML = '';
    
    if (filteredRoasts.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="10" style="text-align: center; padding: 20px;">No roasts match your filters</td>';
        roastTableBody.appendChild(row);
        updateScrollIndicator();
        return;
    }
    
    filteredRoasts.forEach(roast => {
        const row = document.createElement('tr');
        const isSelected = selectedRoastIds.has(roast.id);
        const isHighlighted = highlightedRoastId === roast.id;
        
        // Add data-roast-id attribute for easy lookup when clicking in charts
        row.setAttribute('data-roast-id', roast.id);
        
        // Add highlighted class if this roast is currently highlighted from chart click
        if (isHighlighted) {
            row.classList.add('roast-highlighted');
        }
        
        row.innerHTML = `
            <td><input type="checkbox" class="roast-checkbox" data-id="${roast.id}" ${isSelected ? 'checked' : ''}></td>
            <td>${formatDate(roast.roast_date)}</td>
            <td>${roast.roaster || 'N/A'}</td>
            <td>${roast.origin || 'N/A'}</td>
            <td>${roast.variety || 'N/A'}</td>
            <td><span class="badge badge-process">${roast.process || 'N/A'}</span></td>
            <td>${roast.charge_mass ? roast.charge_mass + 'g' : 'N/A'}</td>
            <td>${roast.final_mass ? roast.final_mass + 'g' : 'N/A'}</td>
            <td>${formatTimestamp(roast.upload_date)}</td>
            <td>
                <button class="btn-edit" data-id="${roast.id}" title="Edit roast">Edit</button>
                <button class="btn-delete" data-id="${roast.id}" data-url="${roast.file_url}" title="Delete roast">Delete</button>
                <button class="btn-download" data-url="${roast.file_url}" data-filename="${roast.filename}" title="Download">Download</button>
            </td>
        `;
        
        roastTableBody.appendChild(row);
    });
    
    // Add event listeners for checkboxes
    document.querySelectorAll('.roast-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handleCheckboxChange);
    });
    
    // Add event listeners for action buttons
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const roast = filteredRoasts.find(r => r.id === (btn as HTMLButtonElement).dataset.id);
            if (roast) openEditModal(roast);
        });
    });
    
    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            const btnEl = btn as HTMLButtonElement;
            deleteRoast(btnEl.dataset.id!, btnEl.dataset.url!);
        });
    });
    
    document.querySelectorAll('.btn-download').forEach(btn => {
        btn.addEventListener('click', () => {
            const btnEl = btn as HTMLButtonElement;
            downloadRoastFile(btnEl.dataset.url!, btnEl.dataset.filename!);
        });
    });
    
    // Update select all checkbox
    updateSelectAllCheckbox();
    
    // Update scroll indicator after DOM update
    requestAnimationFrame(() => {
        updateScrollIndicator();
    });
}

/**
 * Clear all filters
 */
function clearFilters(): void {
    filterOrigin.value = '';
    filterVariety.value = '';
    filterRoaster.value = '';
    filterProcess.value = '';
    sortBy.value = 'upload_date_desc';
    applyFiltersAndSort();
}

// ========================================
// SELECTION MANAGEMENT
// ========================================

/**
 * Handle checkbox change for roast selection
 */
function handleCheckboxChange(e: Event): void {
    const checkbox = e.target as HTMLInputElement;
    const roastId = checkbox.dataset.id!;
    
    if (checkbox.checked) {
        selectedRoastIds.add(roastId);
    } else {
        selectedRoastIds.delete(roastId);
    }
    
    updateSelectionUI();
}

/**
 * Handle select all checkbox
 */
function handleSelectAll(e: Event): void {
    const checkbox = e.target as HTMLInputElement;
    
    if (checkbox.checked) {
        // Select all filtered roasts
        filteredRoasts.forEach(roast => selectedRoastIds.add(roast.id));
    } else {
        // Deselect all filtered roasts
        filteredRoasts.forEach(roast => selectedRoastIds.delete(roast.id));
    }
    
    // Update checkboxes in table
    document.querySelectorAll('.roast-checkbox').forEach(cb => {
        (cb as HTMLInputElement).checked = checkbox.checked;
    });
    
    updateSelectionUI();
}

/**
 * Update select all checkbox state
 */
function updateSelectAllCheckbox(): void {
    if (filteredRoasts.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
    }
    
    const selectedCount = filteredRoasts.filter(r => selectedRoastIds.has(r.id)).length;
    
    if (selectedCount === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === filteredRoasts.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

/**
 * Update selection UI (count and button state)
 */
function updateSelectionUI(): void {
    const count = selectedRoastIds.size;
    
    // Update count display
    selectionCount.textContent = count.toString();
    
    // Enable/disable button based on selection
    if (count === 0) {
        visualizeSelectedBtn.disabled = true;
    } else {
        visualizeSelectedBtn.disabled = false;
    }
    
    updateSelectAllCheckbox();
}

/**
 * Highlight a roast in the table and scroll to it
 * @param roastId - The ID of the roast to highlight
 */
function highlightTableRow(roastId: string | null): void {
    // Remove previous highlighting
    document.querySelectorAll('.roast-highlighted').forEach(row => {
        row.classList.remove('roast-highlighted');
    });
    
    // Update global state
    highlightedRoastId = roastId;
    
    // Add highlighting to the new row if roastId is provided
    if (roastId) {
        const row = document.querySelector(`tr[data-roast-id="${roastId}"]`) as HTMLTableRowElement;
        if (row) {
            row.classList.add('roast-highlighted');
            // Scroll the row into view smoothly
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}


// ========================================
// VISUALIZATION
// ========================================

/**
 * Fetch and parse roast file data
 * @param fileUrl - Storage path of the roast file
 * @param roastId - ID of the roast (for caching)
 * @returns Parsed roast data
 */
async function fetchRoastData(fileUrl: string, roastId: string): Promise<ParsedRoastData> {
    // Check cache first
    if (roastDataCache.has(roastId)) {
        return roastDataCache.get(roastId)!;
    }
    
    // Download file from storage
    const { data, error } = await supabase.storage
        .from('roast-data')
        .download(fileUrl);
    
    if (error) {
        throw error;
    }
    
    // Convert blob to text
    const text = await data.text();
    
    // Parse the file
    const parsedData = parseAlogFile(text);
    
    // Cache the result
    roastDataCache.set(roastId, parsedData);
    
    return parsedData;
}


/**
 * Visualize selected roasts in the inline panel
 */
async function visualizeSelectedRoasts(): Promise<void> {
    if (selectedRoastIds.size === 0) {
        showMessage('Please select at least one roast to visualize', 'info');
        return;
    }
    
    // Update title
    vizPanelTitle.textContent = `Group Visualization (${selectedRoastIds.size} roasts)`;
    
    // Show loading, hide empty state and charts
    vizPanelLoading.style.display = 'block';
    vizPanelEmpty.style.display = 'none';
    vizPanelCharts.style.display = 'none';
    tempChart.innerHTML = '';
    controlChart.innerHTML = '';
    
    try {
        // Fetch all selected roast data
        const roastDataArray: Array<{ roast: Roast, data: ParsedRoastData, ror: number[] }> = [];
        
        for (const roastId of selectedRoastIds) {
            const roast = allRoasts.find(r => r.id === roastId);
            if (!roast) continue;
            
            const data = await fetchRoastData(roast.file_url, roast.id);
            const ror = calculateRateOfRise(data.beanTemp, data.timeMinutes);
            
            roastDataArray.push({ roast, data, ror });
        }
        
        // Create group visualization
        await createRoastVisualization(roastDataArray);
        
        // Hide loading, show charts
        vizPanelLoading.style.display = 'none';
        vizPanelCharts.style.display = 'flex';
        
    } catch (error: any) {
        console.error('Visualization error:', error);
        vizPanelLoading.style.display = 'none';
        vizPanelCharts.style.display = 'flex';
        tempChart.innerHTML = `<div style="padding: 40px; text-align: center; color: #dc3545;">
            Failed to load roast data: ${error.message}
        </div>`;
    }
}

/**
 * Create roast visualization using Plotly in two separate charts
 * Chart 1: Temperature & RoR
 * Chart 2: Control inputs (heater, fan, drum)
 * 
 * Time alignment: All roasts are aligned at their CHARGE point (t=0 at charge)
 * This allows for direct comparison of roast profiles from the moment beans enter the roaster.
 * 
 * @param roasts - Array of roast data with metadata
 */
async function createRoastVisualization(roasts: Array<{ roast: Roast, data: ParsedRoastData, ror: number[] }>): Promise<void> {
    const colors = ['#8B4513', '#FF6B35', '#4ECDC4', '#45B7D1', '#F7B731', '#5F27CD', '#00D2D3', '#1DD1A1'];
    
    // Apply time offset to align all roasts at CHARGE point (t=0)
    // For each roast, we subtract the charge time from all time values
    // This makes the charge moment the origin (t=0) for all roasts
    const alignedRoasts = roasts.map(item => {
        const chargeTime = item.data.chargeTime || 0;  // Default to 0 if no charge time
        
        // Create offset time array: subtract charge time from all time points
        // This shifts the entire roast profile so charge occurs at t=0
        const offsetTimeMinutes = item.data.timeMinutes.map(t => t - chargeTime);
        
        return {
            ...item,
            offsetTimeMinutes,  // New time array aligned to charge
            chargeTime          // Store original charge time for reference
        };
    });
    
    // Calculate axis limits using the offset time
    const allTemps: number[] = [];
    const allRoR: number[] = [];
    let minTime = 0;  // Will be negative if data exists before charge
    let maxTime = 0;
    
    alignedRoasts.forEach(item => {
        allTemps.push(...item.data.beanTemp.filter(t => !isNaN(t)));
        allTemps.push(...item.data.environmentTemp.filter(t => !isNaN(t)));
        allRoR.push(...item.ror.filter(r => !isNaN(r)));
        
        // Find min/max of offset time to set appropriate axis range
        const times = item.offsetTimeMinutes;
        minTime = Math.min(minTime, Math.min(...times));
        maxTime = Math.max(maxTime, Math.max(...times));
    });
    
    const maxTemp = Math.max(250, ...allTemps) + 10;
    const maxRoR = Math.max(20, ...allRoR.filter(r => r > 0)) + 2;
    
    // ========================================
    // TEMPERATURE CHART
    // ========================================
    const tempTraces: any[] = [];
    
    // Use aligned roasts with offset time
    alignedRoasts.forEach((item, idx) => {
        const color = colors[idx % colors.length];
        const label = `${item.roast.origin || 'Unknown'} - ${item.roast.variety || 'Unknown'}`;
        
        // Bean temperature
        // Using offsetTimeMinutes so all roasts are aligned at charge (t=0)
        tempTraces.push({
            x: item.offsetTimeMinutes,
            y: item.data.beanTemp,
            name: `${label} (BT)`,
            line: { color, width: roasts.length === 1 ? 3 : 2 },
            opacity: roasts.length === 1 ? 1 : 0.3,
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>BT: %{y:.1f}°C<extra></extra>`,
            mode: 'lines',
            legendgroup: `group${idx}`,
            showlegend: false
        });
        
        // Environment temperature
        tempTraces.push({
            x: item.offsetTimeMinutes,
            y: item.data.environmentTemp,
            name: `${label} (ET)`,
            line: { color, width: roasts.length === 1 ? 2 : 1, dash: 'dot' },
            opacity: roasts.length === 1 ? 0.7 : 0.2,
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>ET: %{y:.1f}°C<extra></extra>`,
            mode: 'lines',
            legendgroup: `group${idx}`,
            showlegend: false
        });
        
        // RoR (on secondary y-axis)
        tempTraces.push({
            x: item.offsetTimeMinutes,
            y: item.ror,
            name: `${label} (RoR)`,
            line: { color, width: roasts.length === 1 ? 2 : 1, dash: 'dash' },
            opacity: roasts.length === 1 ? 0.6 : 0.2,
            yaxis: 'y2',
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>RoR: %{y:.1f}°C/min<extra></extra>`,
            mode: 'lines',
            legendgroup: `group${idx}`,
            showlegend: false
        });
    });
    
    const tempLayout: any = {
        title: roasts.length === 1 ? 'Temperature & Rate of Rise' : `Temperature Comparison (${roasts.length} roasts) - Aligned at Charge`,
        xaxis: {
            title: 'Time from Charge (minutes)',
            gridcolor: '#e0e0e0',
            range: [minTime - 0.5, maxTime + 1],
            // Add a vertical line at t=0 to mark the charge point
            shapes: [{
                type: 'line',
                x0: 0,
                x1: 0,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: {
                    color: '#666',
                    width: 2,
                    dash: 'dash'
                }
            }],
            annotations: [{
                x: 0,
                y: 1,
                yref: 'paper',
                text: 'CHARGE',
                showarrow: false,
                xanchor: 'center',
                yanchor: 'bottom',
                font: {
                    size: 10,
                    color: '#666'
                }
            }]
        },
        yaxis: {
            title: 'Temperature (°C)',
            side: 'left',
            gridcolor: '#e0e0e0',
            range: [0, maxTemp]  // Start at 0
        },
        yaxis2: {
            title: 'Rate of Rise (°C/min)',
            side: 'right',
            overlaying: 'y',
            showgrid: false,
            range: [0, maxRoR]  // Strictly positive
        },
        hovermode: 'closest',
        showlegend: false,  // Hide legend - hover info provides identification
        margin: { t: 50, r: 80, b: 50, l: 60 },  // Standard margins
        autosize: true  // Enable autosizing to container
    };
    
    const config = {
        responsive: true,
        displayModeBar: true,
        displaylogo: false
    };
    
    // Hide chart during creation to avoid flash of incorrectly sized chart
    tempChart.style.visibility = 'hidden';
    
    // Create temperature plot
    await Plotly.newPlot(tempChart, tempTraces, tempLayout, config);
    
    // Trigger resize after DOM layout is complete, then show the chart
    requestAnimationFrame(() => {
        Plotly.Plots.resize(tempChart);
        tempChart.style.visibility = 'visible';
    });
    
    // Add linked hover interactions for temperature chart
    // When hovering over a roast in the temp chart, highlight it in both charts
    if (roasts.length > 1) {
        (tempChart as any).on('plotly_hover', (data: any) => {
            const pointIndex = data.points[0].curveNumber;
            const groupIndex = Math.floor(pointIndex / 3);
            
            // Update temperature chart - highlight hovered group, dim others
            const tempUpdate: any = {
                opacity: tempTraces.map((_, idx) => 
                    Math.floor(idx / 3) === groupIndex ? 1 : 0.15
                )
            };
            Plotly.restyle(tempChart, tempUpdate);
            
            // Update control chart - highlight the same roast group
            const controlUpdate: any = {
                opacity: controlTraces.map((_, idx) => 
                    Math.floor(idx / 3) === groupIndex ? 1 : 0.15
                )
            };
            Plotly.restyle(controlChart, controlUpdate);
        });
        
        (tempChart as any).on('plotly_unhover', () => {
            // Reset both charts to default opacity
            const tempUpdate: any = {
                opacity: tempTraces.map(() => 0.3)
            };
            Plotly.restyle(tempChart, tempUpdate);
            
            const controlUpdate: any = {
                opacity: controlTraces.map(() => 0.3)
            };
            Plotly.restyle(controlChart, controlUpdate);
        });
        
        // Add click event handler to highlight table row
        // When clicking on a roast line in the chart, highlight the corresponding table row
        (tempChart as any).on('plotly_click', (data: any) => {
            const pointIndex = data.points[0].curveNumber;
            const groupIndex = Math.floor(pointIndex / 3);
            
            // Get the roast ID from the alignedRoasts array
            const clickedRoast = alignedRoasts[groupIndex];
            if (clickedRoast) {
                highlightTableRow(clickedRoast.roast.id);
            }
        });
    }
    
    // ========================================
    // CONTROL CHART
    // ========================================
    const controlTraces: any[] = [];
    
    // Use aligned roasts with offset time
    alignedRoasts.forEach((item, idx) => {
        const label = `${item.roast.origin || 'Unknown'} - ${item.roast.variety || 'Unknown'}`;
        
        // Heater
        controlTraces.push({
            x: item.offsetTimeMinutes,
            y: item.data.heater,
            name: `${label} (Heat)`,
            line: { color: '#FF4444', width: roasts.length === 1 ? 2 : 1.5 },
            opacity: roasts.length === 1 ? 1 : 0.3,
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>Heat: %{y:.1f}%<extra></extra>`,
            mode: 'lines',
            legendgroup: `control${idx}`,
            showlegend: false
        });
        
        // Fan
        controlTraces.push({
            x: item.offsetTimeMinutes,
            y: item.data.fan,
            name: `${label} (Fan)`,
            line: { color: '#4444FF', width: roasts.length === 1 ? 2 : 1.5 },
            opacity: roasts.length === 1 ? 1 : 0.3,
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>Fan: %{y:.1f}%<extra></extra>`,
            mode: 'lines',
            legendgroup: `control${idx}`,
            showlegend: false
        });
        
        // Drum
        controlTraces.push({
            x: item.offsetTimeMinutes,
            y: item.data.drum,
            name: `${label} (Drum)`,
            line: { color: '#888888', width: roasts.length === 1 ? 2 : 1.5, dash: 'dash' },
            opacity: roasts.length === 1 ? 1 : 0.3,
            hovertemplate: `<b>${label}</b><br>Date: ${formatDate(item.roast.roast_date)}<br>Time from charge: %{x:.1f} min<br>Drum: %{y:.1f}%<extra></extra>`,
            mode: 'lines',
            legendgroup: `control${idx}`,
            showlegend: false
        });
    });
    
    const controlLayout: any = {
        title: roasts.length === 1 ? 'Control Inputs' : `Control Comparison (${roasts.length} roasts) - Aligned at Charge`,
        xaxis: {
            title: 'Time from Charge (minutes)',
            gridcolor: '#e0e0e0',
            range: [minTime - 0.5, maxTime + 1],
            // Add a vertical line at t=0 to mark the charge point
            shapes: [{
                type: 'line',
                x0: 0,
                x1: 0,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: {
                    color: '#666',
                    width: 2,
                    dash: 'dash'
                }
            }],
            annotations: [{
                x: 0,
                y: 1,
                yref: 'paper',
                text: 'CHARGE',
                showarrow: false,
                xanchor: 'center',
                yanchor: 'bottom',
                font: {
                    size: 10,
                    color: '#666'
                }
            }]
        },
        yaxis: {
            title: 'Control Value (%)',
            gridcolor: '#e0e0e0',
            range: [0, 100]
        },
        hovermode: 'closest',
        showlegend: false,  // Hide legend - hover info provides identification
        margin: { t: 50, r: 80, b: 50, l: 60 },  // Standard margins, matches temp chart
        autosize: true  // Enable autosizing to container
    };
    
    // Hide chart during creation to avoid flash of incorrectly sized chart
    controlChart.style.visibility = 'hidden';
    
    // Create control plot
    await Plotly.newPlot(controlChart, controlTraces, controlLayout, config);
    
    // Trigger resize after DOM layout is complete, then show the chart
    requestAnimationFrame(() => {
        Plotly.Plots.resize(controlChart);
        controlChart.style.visibility = 'visible';
    });
    
    // Add linked hover interactions for control chart
    // When hovering over a roast in the control chart, highlight it in both charts
    if (roasts.length > 1) {
        (controlChart as any).on('plotly_hover', (data: any) => {
            const pointIndex = data.points[0].curveNumber;
            const groupIndex = Math.floor(pointIndex / 3);
            
            // Update control chart - highlight hovered group, dim others
            const controlUpdate: any = {
                opacity: controlTraces.map((_, idx) => 
                    Math.floor(idx / 3) === groupIndex ? 1 : 0.15
                )
            };
            Plotly.restyle(controlChart, controlUpdate);
            
            // Update temperature chart - highlight the same roast group
            const tempUpdate: any = {
                opacity: tempTraces.map((_, idx) => 
                    Math.floor(idx / 3) === groupIndex ? 1 : 0.15
                )
            };
            Plotly.restyle(tempChart, tempUpdate);
        });
        
        (controlChart as any).on('plotly_unhover', () => {
            // Reset both charts to default opacity
            const controlUpdate: any = {
                opacity: controlTraces.map(() => 0.3)
            };
            Plotly.restyle(controlChart, controlUpdate);
            
            const tempUpdate: any = {
                opacity: tempTraces.map(() => 0.3)
            };
            Plotly.restyle(tempChart, tempUpdate);
        });
        
        // Add click event handler to highlight table row
        // When clicking on a roast line in the control chart, highlight the corresponding table row
        (controlChart as any).on('plotly_click', (data: any) => {
            const pointIndex = data.points[0].curveNumber;
            const groupIndex = Math.floor(pointIndex / 3);
            
            // Get the roast ID from the alignedRoasts array
            const clickedRoast = alignedRoasts[groupIndex];
            if (clickedRoast) {
                highlightTableRow(clickedRoast.roast.id);
            }
        });
    }
}

// ========================================
// EVENT LISTENERS
// ========================================

// Filter and sort listeners
filterOrigin.addEventListener('input', applyFiltersAndSort);
filterVariety.addEventListener('input', applyFiltersAndSort);
filterRoaster.addEventListener('input', applyFiltersAndSort);
filterProcess.addEventListener('change', applyFiltersAndSort);
sortBy.addEventListener('change', applyFiltersAndSort);
clearFiltersBtn.addEventListener('click', clearFilters);

// Selection listeners
selectAllCheckbox.addEventListener('change', handleSelectAll);
visualizeSelectedBtn.addEventListener('click', visualizeSelectedRoasts);

// Update scroll indicator on window resize
window.addEventListener('resize', () => {
    updateScrollIndicator();
});

// Hide scroll indicator when user scrolls
historyTableContainer.addEventListener('scroll', () => {
    if (historyTableContainer.scrollLeft > 0) {
        historyTableContainer.classList.remove('has-scroll');
    }
});

// ========================================
// TESTBED INTEGRATION
// ========================================

let testbed: Testbed | null = null;

/**
 * Initialize the digital testbed
 */
function initTestbed(): void {
    if (!testbed) {
        testbed = new Testbed();
        console.log('✅ Digital Testbed initialized');
    }
}

/**
 * Handle sidebar navigation
 */
function setupSidebarNavigation(): void {
    const sidebarLinks = document.querySelectorAll('.sidebar-link');
    
    sidebarLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const page = (link as HTMLElement).dataset.page;
            
            // Handle different page types
            if (page === 'testbed') {
                e.preventDefault();
                
                // Update active state
                sidebarLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                
                // Hide view tabs (data manager UI)
                const viewTabs = document.querySelector('.view-tabs') as HTMLDivElement;
                if (viewTabs) viewTabs.style.display = 'none';
                
                // Show testbed view, hide others
                views.forEach(view => view.classList.remove('active'));
                const testbedView = document.getElementById('testbed-view');
                if (testbedView) testbedView.classList.add('active');
                
                // Initialize testbed if not already done
                initTestbed();
            } else if (page === 'data-manager') {
                e.preventDefault();
                
                // Update active state
                sidebarLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                
                // Show view tabs
                const viewTabs = document.querySelector('.view-tabs') as HTMLDivElement;
                if (viewTabs) viewTabs.style.display = 'flex';
                
                // Show history view by default
                views.forEach(view => view.classList.remove('active'));
                const historyView = document.getElementById('history-view');
                if (historyView) historyView.classList.add('active');
                
                // Load history
                loadRoastHistory();
            }
            // training page handled by natural link navigation
        });
    });
}

// ========================================
// INITIALIZATION
// ========================================

/**
 * Initialize dashboard on page load
 */
async function init(): Promise<void> {
    // Check authentication first
    await checkAuth();
    
    // Setup sidebar navigation
    setupSidebarNavigation();
    
    // Load initial data
    if (currentUser) {
        loadRoastHistory();
    }
}

// Run initialization when page loads
init();
