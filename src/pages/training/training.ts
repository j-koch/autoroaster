/**
 * Training page functionality - Refactored
 * 
 * This module handles:
 * - Tab navigation between Model Library and Training Jobs views
 * - Loading and displaying trained models with inspection
 * - Configuring training job parameters with enhanced roast filtering
 * - Submitting training jobs to Modal via Supabase Edge Functions
 * - Monitoring training job status and progress
 * - Terminating and deleting training jobs
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import Plotly from 'plotly.js-dist-min';

// ========================================
// TYPES
// ========================================

/**
 * Roast metadata from the database
 * Extended with detailed fields for filtering and display
 */
interface Roast {
    id: string;
    filename: string;
    variety: string | null;
    origin: string | null;
    process: string | null;
    roast_date: string | null;
    roaster: string | null;
    charge_mass: number | null;
    final_mass: number | null;
}

/**
 * Training job configuration structure
 * These parameters control the data preprocessing, model architecture, and training process
 */
interface TrainingConfig {
    data: {
        batch_size: number;          // Number of samples per training batch
        sequence_length: number;     // Length of time sequences (in time steps)
        stride: number;              // Stride for creating overlapping sequences
        include_mass: boolean;       // Whether to include mass data
        include_dt: boolean;         // Whether to include time deltas
        feature_sets: string[];      // Which feature sets to include
        delay: {
            time_horizon: number;    // Maximum delay time in seconds
            num_points: number;      // Number of delay points to sample
        };
    };
    model: {
        n_latents: number;           // Dimensionality of the latent space
        roaster_type: string;        // Type of roaster (e.g., 'drum')
        roaster_hidden_dims: number[]; // Hidden layer dimensions for roaster model
        estimator_hidden_dim: number;  // Hidden dimension for state estimator
    };
    training: {
        lr: number;                  // Learning rate
        max_epochs: number;          // Maximum number of training epochs
        patience: number;            // Early stopping patience
        plot_interval: number;       // How often to plot during training
        estim_weight: number;        // Weight for estimator loss
        cb_weight: number;           // Smoothing penalty on C_b
        charge_weight: number;       // Bean charge temperature penalty weight
        air_temp_weight: number;     // Air temperature consistency penalty weight
        scheduler_factor: number;    // Learning rate scheduler reduction factor
        scheduler_patience: number;  // Learning rate scheduler patience
        scheduler_min_lr: number;    // Minimum learning rate
        scheduler_verbose: boolean;  // Print when LR is reduced
    };
}

/**
 * Training job record from the database
 * Status can be: pending, running, completed, or failed
 */
interface TrainingJob {
    id: string;
    user_id: string;
    job_name: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    config: TrainingConfig;
    roast_file_ids: string[];
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    duration_seconds: number | null;
    error_message: string | null;
    loss_history: {
        total?: number[];
        recon?: number[];
        estim?: number[];
    } | null;
}

// ========================================
// GLOBAL STATE
// ========================================
let roasts: Roast[] = [];                    // All available roasts for training
let filteredRoasts: Roast[] = [];           // Filtered roasts based on current filters
let selectedRoastIds = new Set<string>();    // Currently selected roast IDs for training
let allJobs: TrainingJob[] = [];            // All training jobs
let currentJobFilter: string = 'all';       // Current job status filter
let selectedModelId: string | null = null;   // Currently selected model for inspection
let expandedJobIds = new Set<string>();      // Track which jobs are currently expanded

// ========================================
// AUTHENTICATION
// ========================================

/**
 * Check if user is authenticated
 * Redirect to login if not
 */
async function checkAuth(): Promise<User | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.location.href = '/login.html';
        return null;
    }
    
    // Display user email in navbar
    const userEmailEl = document.getElementById('user-email');
    if (userEmailEl) {
        userEmailEl.textContent = session.user.email || 'User';
    }
    
    return session.user;
}

/**
 * Sign out the current user
 */
async function signOut(): Promise<void> {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
}

// ========================================
// TAB NAVIGATION
// ========================================

/**
 * Initialize tab switching functionality
 * Handles switching between Model Library and Training Jobs views
 */
function initTabSwitching(): void {
    const viewTabs = document.querySelectorAll('.view-tab');
    const views = document.querySelectorAll('.view');
    
    viewTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetView = tab.getAttribute('data-view');
            
            // Update active tab styling
            viewTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Switch views (hide all, show target)
            views.forEach(v => v.classList.remove('active'));
            const targetElement = document.getElementById(`${targetView}-view`);
            if (targetElement) {
                targetElement.classList.add('active');
            }
        });
    });
}

// ========================================
// MODEL LIBRARY VIEW
// ========================================

/**
 * Load all completed training jobs as models
 * Models are training jobs with status 'completed'
 */
async function loadModels(): Promise<void> {
    const loadingEl = document.getElementById('models-loading');
    const emptyEl = document.getElementById('models-empty');
    const listEl = document.getElementById('models-list');
    
    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    if (listEl) listEl.style.display = 'none';
    
    try {
        // Query for completed training jobs (these are our "models")
        const { data, error } = await supabase
            .from('training_jobs')
            .select('*')
            .eq('status', 'completed')
            .order('completed_at', { ascending: false });
        
        if (error) throw error;
        
        const models = data as TrainingJob[];
        
        if (models.length === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        
        displayModels(models);
        
        if (loadingEl) loadingEl.style.display = 'none';
        if (listEl) listEl.style.display = 'block';
        
    } catch (error: any) {
        console.error('Error loading models:', error);
        if (loadingEl) {
            loadingEl.innerHTML = '<div class="error-message">Failed to load models</div>';
        }
    }
}

/**
 * Display models in the model list
 * @param models - Array of completed training jobs (models)
 */
function displayModels(models: TrainingJob[]): void {
    const container = document.getElementById('models-list');
    if (!container) return;
    
    container.innerHTML = models.map(model => {
        const finalLoss = model.loss_history?.total?.slice(-1)[0];
        const numEpochs = model.loss_history?.total?.length || 0;
        
        return `
            <div class="model-card ${selectedModelId === model.id ? 'selected' : ''}" 
                 data-model-id="${model.id}">
                <div class="model-card-header">
                    <div class="model-name">${model.job_name || 'Unnamed Model'}</div>
                    <div class="model-actions">
                        <div class="model-status ${model.status}">${model.status.toUpperCase()}</div>
                        <button class="btn-small btn-delete-model" data-model-id="${model.id}" title="Delete model">🗑️</button>
                    </div>
                </div>
                <div class="model-info">
                    📁 Trained on ${model.roast_file_ids.length} roast${model.roast_file_ids.length !== 1 ? 's' : ''}
                </div>
                <div class="model-info">
                    📅 ${new Date(model.completed_at!).toLocaleString()}
                </div>
                <div class="model-metrics">
                    <div class="model-metric">
                        <strong>${numEpochs}</strong> epochs
                    </div>
                    <div class="model-metric">
                        Final loss: <strong>${finalLoss?.toFixed(4) || 'N/A'}</strong>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // Add click handlers to model cards
    container.querySelectorAll('.model-card').forEach(card => {
        card.addEventListener('click', (e) => {
            // Don't select if clicking on delete button
            if ((e.target as HTMLElement).classList.contains('btn-delete-model')) {
                return;
            }
            
            const modelId = card.getAttribute('data-model-id');
            if (modelId) {
                selectModel(modelId, models);
            }
        });
    });
    
    // Add event listeners for delete buttons
    container.querySelectorAll('.btn-delete-model').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation(); // Prevent card selection when clicking delete
            const modelId = (e.target as HTMLElement).getAttribute('data-model-id');
            if (modelId) {
                const model = models.find(m => m.id === modelId);
                if (model) {
                    await deleteModel(modelId, model.job_name || 'this model');
                }
            }
        });
    });
}

/**
 * Select a model and display its details in the inspection panel
 * @param modelId - ID of the selected model
 * @param models - Array of all models
 */
function selectModel(modelId: string, models: TrainingJob[]): void {
    selectedModelId = modelId;
    
    // Update selected styling on model cards
    document.querySelectorAll('.model-card').forEach(card => {
        if (card.getAttribute('data-model-id') === modelId) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
    
    // Find the selected model
    const model = models.find(m => m.id === modelId);
    if (!model) return;
    
    displayModelInspection(model);
}

/**
 * Display detailed model information in the inspection panel
 * @param model - The training job (model) to inspect
 */
function displayModelInspection(model: TrainingJob): void {
    const titleEl = document.getElementById('inspection-panel-title');
    const emptyEl = document.getElementById('inspection-empty');
    const loadingEl = document.getElementById('inspection-loading');
    const detailsEl = document.getElementById('inspection-details');
    
    if (titleEl) titleEl.textContent = model.job_name || 'Model Details';
    if (emptyEl) emptyEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'none';
    if (detailsEl) {
        detailsEl.style.display = 'block';
        
        // Build the inspection HTML
        const finalLoss = model.loss_history?.total?.slice(-1)[0];
        const numEpochs = model.loss_history?.total?.length || 0;
        
        detailsEl.innerHTML = `
            <div class="detail-section">
                <h4>Training Information</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-label">Job Name</div>
                        <div class="detail-value">${model.job_name || 'Unnamed'}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Status</div>
                        <div class="detail-value">${model.status}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Training Duration</div>
                        <div class="detail-value">${model.duration_seconds}s</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Epochs Completed</div>
                        <div class="detail-value">${numEpochs}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Final Loss</div>
                        <div class="detail-value">${finalLoss?.toFixed(4) || 'N/A'}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Training Data</div>
                        <div class="detail-value">${model.roast_file_ids.length} roasts</div>
                    </div>
                </div>
            </div>
            
            <div class="detail-section">
                <h4>Model Configuration</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-label">Latent Dimensions</div>
                        <div class="detail-value">${model.config.model.n_latents}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Roaster Type</div>
                        <div class="detail-value">${model.config.model.roaster_type}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Estimator Hidden Dim</div>
                        <div class="detail-value">${model.config.model.estimator_hidden_dim}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Batch Size</div>
                        <div class="detail-value">${model.config.data.batch_size}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Sequence Length</div>
                        <div class="detail-value">${model.config.data.sequence_length}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Learning Rate</div>
                        <div class="detail-value">${model.config.training.lr}</div>
                    </div>
                </div>
            </div>
            
            <div class="detail-section">
                <h4>Loss History</h4>
                <div id="model-loss-chart" class="loss-chart-container"></div>
            </div>
            
            <div class="detail-section">
                <h4>Timestamps</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-label">Created</div>
                        <div class="detail-value">${new Date(model.created_at).toLocaleString()}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Started</div>
                        <div class="detail-value">${model.started_at ? new Date(model.started_at).toLocaleString() : 'N/A'}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Completed</div>
                        <div class="detail-value">${model.completed_at ? new Date(model.completed_at).toLocaleString() : 'N/A'}</div>
                    </div>
                </div>
            </div>
        `;
        
        // Plot loss history if available
        if (model.loss_history?.total && model.loss_history.total.length > 0) {
            plotLossHistory(model.loss_history);
        }
    }
}

/**
 * Plot the loss history for a model
 * @param lossHistory - Object containing arrays of loss values (total, recon, estim)
 */
function plotLossHistory(lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const container = document.getElementById('model-loss-chart');
    if (!container) return;
    
    const traces: any[] = [];
    
    // Total loss trace
    if (lossHistory.total && lossHistory.total.length > 0) {
        traces.push({
            y: lossHistory.total,
            name: 'Total Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#8B4513', width: 2 }
        });
    }
    
    // Reconstruction loss trace
    if (lossHistory.recon && lossHistory.recon.length > 0) {
        traces.push({
            y: lossHistory.recon,
            name: 'Reconstruction Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#007bff', width: 1.5 }
        });
    }
    
    // Estimator loss trace
    if (lossHistory.estim && lossHistory.estim.length > 0) {
        traces.push({
            y: lossHistory.estim,
            name: 'Estimator Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#28a745', width: 1.5 }
        });
    }
    
    const layout = {
        title: 'Training Loss History',
        xaxis: { title: 'Epoch' },
        yaxis: { title: 'Loss', type: 'log' as const },
        height: 300,
        margin: { l: 60, r: 30, t: 40, b: 40 }
    };
    
    Plotly.newPlot(container, traces, layout, { responsive: true });
}

// ========================================
// TRAINING JOBS VIEW - ROAST LOADING & FILTERING
// ========================================

/**
 * Load available roasts from the database for training selection
 */
async function loadRoasts(): Promise<void> {
    try {
        const { data, error } = await supabase
            .from('roasts')
            .select('*')
            .order('roast_date', { ascending: false });

        if (error) throw error;

        roasts = data as Roast[];
        filteredRoasts = [...roasts];
        displayRoasts();
    } catch (error: any) {
        console.error('Error loading roasts:', error);
        const roastSelector = document.getElementById('roastSelector');
        if (roastSelector) {
            roastSelector.innerHTML = '<div class="error-message">Failed to load roasts</div>';
        }
    }
}

/**
 * Apply filters and sorting to the roasts list
 */
function applyRoastFilters(): void {
    const originFilter = (document.getElementById('training-filter-origin') as HTMLInputElement)?.value.toLowerCase() || '';
    const varietyFilter = (document.getElementById('training-filter-variety') as HTMLInputElement)?.value.toLowerCase() || '';
    const processFilter = (document.getElementById('training-filter-process') as HTMLSelectElement)?.value || '';
    const sortBy = (document.getElementById('training-sort-by') as HTMLSelectElement)?.value || 'roast_date_desc';
    
    // Filter roasts
    filteredRoasts = roasts.filter(roast => {
        const matchesOrigin = !originFilter || (roast.origin?.toLowerCase().includes(originFilter) ?? false);
        const matchesVariety = !varietyFilter || (roast.variety?.toLowerCase().includes(varietyFilter) ?? false);
        const matchesProcess = !processFilter || roast.process === processFilter;
        
        return matchesOrigin && matchesVariety && matchesProcess;
    });
    
    // Sort roasts
    filteredRoasts.sort((a, b) => {
        switch (sortBy) {
            case 'roast_date_asc':
                return (a.roast_date || '').localeCompare(b.roast_date || '');
            case 'roast_date_desc':
                return (b.roast_date || '').localeCompare(a.roast_date || '');
            case 'origin_asc':
                return (a.origin || '').localeCompare(b.origin || '');
            case 'origin_desc':
                return (b.origin || '').localeCompare(a.origin || '');
            default:
                return 0;
        }
    });
    
    displayRoasts();
}

/**
 * Display roasts in a table format with checkboxes for selection
 * Table structure matches dashboard.html for consistency
 */
function displayRoasts(): void {
    const container = document.getElementById('roastSelector');
    if (!container) return;
    
    if (filteredRoasts.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No roasts match your filters</div>';
        return;
    }
    
    // Helper function to format mass values
    const formatMass = (mass: number | null): string => {
        if (mass === null || mass === undefined) return 'N/A';
        return `${mass.toFixed(1)}g`;
    };
    
    // Check if all filtered roasts are selected (for select-all checkbox state)
    const allFilteredSelected = filteredRoasts.length > 0 && 
        filteredRoasts.every(roast => selectedRoastIds.has(roast.id));
    
    // Build the tbody content using the roast data
    const tbodyContent = filteredRoasts.map(roast => {
        // Format the upload date - assuming created_at is in the roast data
        // If not available, we'll use roast_date as fallback
        const uploadDate = new Date(roast.roast_date || '').toLocaleDateString();
        
        return `
            <tr class="${selectedRoastIds.has(roast.id) ? 'selected' : ''}" data-roast-id="${roast.id}">
                <td><input type="checkbox" class="roast-checkbox" data-roast-id="${roast.id}" ${selectedRoastIds.has(roast.id) ? 'checked' : ''}></td>
                <td>${roast.roast_date ? new Date(roast.roast_date).toLocaleDateString() : 'N/A'}</td>
                <td>${roast.roaster || 'Unknown'}</td>
                <td>${roast.origin || 'Unknown'}</td>
                <td>${roast.variety || 'Unknown'}</td>
                <td>${roast.process || 'Unknown'}</td>
                <td>${formatMass(roast.charge_mass)}</td>
                <td>${formatMass(roast.final_mass)}</td>
                <td>${uploadDate}</td>
            </tr>
        `;
    }).join('');
    
    // Update the tbody in the existing table structure
    const tbody = document.getElementById('roast-table-body');
    if (tbody) {
        tbody.innerHTML = tbodyContent;
    } else {
        // If tbody doesn't exist (shouldn't happen with new HTML), create full table
        container.innerHTML = `
            <table class="roast-table">
                <thead>
                    <tr>
                        <th><input type="checkbox" id="select-all" title="Select all"></th>
                        <th>Date</th>
                        <th>Roaster</th>
                        <th>Origin</th>
                        <th>Variety</th>
                        <th>Process</th>
                        <th>Charge</th>
                        <th>Final</th>
                        <th>Uploaded</th>
                    </tr>
                </thead>
                <tbody id="roast-table-body">
                    ${tbodyContent}
                </tbody>
            </table>
        `;
    }
    
    // Update select-all checkbox state
    const selectAllCheckbox = document.getElementById('select-all') as HTMLInputElement;
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = allFilteredSelected;
        
        // Remove old event listener by cloning and replacing
        const newSelectAllCheckbox = selectAllCheckbox.cloneNode(true) as HTMLInputElement;
        selectAllCheckbox.parentNode?.replaceChild(newSelectAllCheckbox, selectAllCheckbox);
        
        newSelectAllCheckbox.addEventListener('change', (e) => {
            const checked = (e.target as HTMLInputElement).checked;
            filteredRoasts.forEach(roast => {
                if (checked) {
                    selectedRoastIds.add(roast.id);
                } else {
                    selectedRoastIds.delete(roast.id);
                }
            });
            displayRoasts();
        });
    }
    
    // Individual checkbox handlers
    document.querySelectorAll('.roast-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const roastId = (e.target as HTMLElement).getAttribute('data-roast-id');
            if (!roastId) return;
            
            const checked = (e.target as HTMLInputElement).checked;
            if (checked) {
                selectedRoastIds.add(roastId);
            } else {
                selectedRoastIds.delete(roastId);
            }
            
            // Update row styling
            const row = (e.target as HTMLElement).closest('tr');
            if (row) {
                if (checked) {
                    row.classList.add('selected');
                } else {
                    row.classList.remove('selected');
                }
            }
            
            updateSelectedCount();
            
            // Update select-all checkbox state
            const selectAll = document.getElementById('select-all') as HTMLInputElement;
            if (selectAll) {
                const allSelected = filteredRoasts.every(r => selectedRoastIds.has(r.id));
                selectAll.checked = allSelected;
            }
        });
    });
    
    updateSelectedCount();
}

/**
 * Update the selected count display
 */
function updateSelectedCount(): void {
    const countEl = document.getElementById('selectedCount');
    if (countEl) {
        countEl.textContent = selectedRoastIds.size.toString();
    }
}

/**
 * Initialize roast filter event listeners
 */
function initRoastFilters(): void {
    const originFilter = document.getElementById('training-filter-origin');
    const varietyFilter = document.getElementById('training-filter-variety');
    const processFilter = document.getElementById('training-filter-process');
    const sortBy = document.getElementById('training-sort-by');
    
    [originFilter, varietyFilter, processFilter, sortBy].forEach(el => {
        if (el) {
            el.addEventListener('change', applyRoastFilters);
            el.addEventListener('input', applyRoastFilters);
        }
    });
}

// ========================================
// TRAINING JOB SUBMISSION
// ========================================

/**
 * Start a new training job
 */
async function startTraining(): Promise<void> {
    const messageEl = document.getElementById('message');
    if (messageEl) {
        messageEl.style.display = 'none';
        messageEl.className = 'message';
    }

    // Validation: Check if roasts are selected
    if (selectedRoastIds.size === 0) {
        showMessage('Please select at least one roast file', 'error');
        return;
    }

    try {
        // Build configuration object from form inputs
        const config: TrainingConfig = {
            data: {
                batch_size: parseInt((document.getElementById('batchSize') as HTMLInputElement).value),
                sequence_length: parseInt((document.getElementById('sequenceLength') as HTMLInputElement).value),
                stride: parseInt((document.getElementById('stride') as HTMLInputElement).value),
                include_mass: true,
                include_dt: true,
                feature_sets: ['delayed_observables', 'delayed_inputs', 'delayed_observables_derivatives'],
                delay: {
                    time_horizon: parseFloat((document.getElementById('delayHorizon') as HTMLInputElement).value),
                    num_points: parseInt((document.getElementById('delayPoints') as HTMLInputElement).value)
                }
            },
            model: {
                n_latents: parseInt((document.getElementById('nLatents') as HTMLInputElement).value),
                roaster_type: 'drum',
                roaster_hidden_dims: [1, 3],
                estimator_hidden_dim: parseInt((document.getElementById('estimatorHidden') as HTMLInputElement).value)
            },
            training: {
                lr: parseFloat((document.getElementById('learningRate') as HTMLInputElement).value),
                max_epochs: parseInt((document.getElementById('maxEpochs') as HTMLInputElement).value),
                patience: parseInt((document.getElementById('patience') as HTMLInputElement).value),
                plot_interval: 10,
                estim_weight: 0.01,
                cb_weight: parseFloat((document.getElementById('cbWeight') as HTMLInputElement).value),
                charge_weight: parseFloat((document.getElementById('chargeWeight') as HTMLInputElement).value),
                air_temp_weight: parseFloat((document.getElementById('airTempWeight') as HTMLInputElement).value),
                scheduler_factor: parseFloat((document.getElementById('schedulerFactor') as HTMLInputElement).value),
                scheduler_patience: parseInt((document.getElementById('schedulerPatience') as HTMLInputElement).value),
                scheduler_min_lr: parseFloat((document.getElementById('schedulerMinLr') as HTMLInputElement).value),
                scheduler_verbose: (document.getElementById('schedulerVerbose') as HTMLInputElement).checked
            }
        };

        // Create job name
        const jobName = (document.getElementById('jobName') as HTMLInputElement).value || 
                       `Training Job ${new Date().toLocaleString()}`;

        // Get current user
        const { data: { user } } = await supabase.auth.getUser();
        
        if (!user) {
            throw new Error('Not authenticated');
        }

        // Insert training job into database
        const { data: job, error: jobError } = await supabase
            .from('training_jobs')
            .insert({
                user_id: user.id,
                job_name: jobName,
                status: 'pending',
                config: config,
                roast_file_ids: Array.from(selectedRoastIds)
            })
            .select()
            .single();

        if (jobError) throw jobError;

        showMessage('Training job created! Triggering Modal...', 'info');

        // Call Supabase Edge Function to trigger Modal
        const response = await supabase.functions.invoke('trigger-training', {
            body: {
                jobId: job.id,
                roastFileIds: Array.from(selectedRoastIds),
                config: config
            }
        });

        if (response.error) throw response.error;

        showMessage('Training started successfully! Check the jobs panel for progress.', 'success');
        
        // Reset form
        selectedRoastIds.clear();
        displayRoasts();
        (document.getElementById('jobName') as HTMLInputElement).value = '';
        
        // Reload jobs list
        loadJobs();

    } catch (error: any) {
        console.error('Error starting training:', error);
        showMessage(`Failed to start training: ${error.message}`, 'error');
    }
}

/**
 * Show a message to the user
 * @param text - Message text to display
 * @param type - Message type: 'success', 'error', or 'info'
 */
function showMessage(text: string, type: 'success' | 'error' | 'info'): void {
    const messageEl = document.getElementById('message');
    if (messageEl) {
        messageEl.textContent = text;
        messageEl.className = `message ${type}`;
        messageEl.style.display = 'block';
        
        // Auto-hide success messages after 5 seconds
        if (type === 'success') {
            setTimeout(() => {
                messageEl.style.display = 'none';
            }, 5000);
        }
    }
}

// ========================================
// TRAINING JOBS MONITORING
// ========================================

/**
 * Load training jobs from the database
 */
async function loadJobs(): Promise<void> {
    try {
        const { data, error } = await supabase
            .from('training_jobs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        allJobs = data as TrainingJob[];
        displayJobs();
    } catch (error: any) {
        console.error('Error loading jobs:', error);
        const jobsList = document.getElementById('jobsList');
        if (jobsList) {
            jobsList.innerHTML = '<div class="error-message">Failed to load jobs</div>';
        }
    }
}

/**
 * Update an individual job card without full re-render
 * This is used for running jobs to avoid flickering
 * @param job - The training job to update
 */
function updateJobCard(job: TrainingJob): void {
    const jobCard = document.querySelector(`.job-card[data-job-id="${job.id}"]`) as HTMLElement;
    if (!jobCard) return;
    
    // Update progress bar for running jobs
    if (job.status === 'running' && job.loss_history?.total && job.loss_history.total.length > 0) {
        const currentEpoch = job.loss_history.total.length;
        const maxEpochs = job.config?.training?.max_epochs || 1000;
        const progress = Math.round((currentEpoch / maxEpochs) * 100);
        
        const progressBar = jobCard.querySelector('.progress-bar');
        if (progressBar) {
            const progressFill = progressBar.querySelector('.progress-fill') as HTMLElement;
            if (progressFill) {
                progressFill.style.width = `${progress}%`;
                progressFill.textContent = `${progress}%`;
            }
        }
        
        // Update chart data for running jobs (they're always expanded)
        const chartContainer = document.getElementById(`job-loss-chart-${job.id}`);
        if (chartContainer && job.loss_history) {
            updateJobLossChart(job.id, job.loss_history);
        }
    }
}

/**
 * Update the Plotly chart data without destroying and recreating the plot
 * This prevents flickering for running jobs
 * @param jobId - ID of the job
 * @param lossHistory - Updated loss history data
 */
function updateJobLossChart(jobId: string, lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const container = document.getElementById(`job-loss-chart-${jobId}`);
    if (!container) return;
    
    // Check if the plot exists
    const plotData = (container as any).data;
    
    if (plotData && plotData.length > 0) {
        // Update existing plot data
        const updates: any = { y: [] };
        
        if (lossHistory.total && lossHistory.total.length > 0) {
            updates.y[0] = lossHistory.total;
        }
        if (lossHistory.recon && lossHistory.recon.length > 0) {
            updates.y[1] = lossHistory.recon;
        }
        if (lossHistory.estim && lossHistory.estim.length > 0) {
            updates.y[2] = lossHistory.estim;
        }
        
        // Use Plotly.update to modify data without full re-render
        Plotly.update(container, updates, {});
    } else {
        // Plot doesn't exist yet, create it
        plotJobLossHistory(jobId, lossHistory);
    }
}

/**
 * Display training jobs in the UI with filtering
 */
function displayJobs(): void {
    const container = document.getElementById('jobsList');
    if (!container) return;
    
    // Filter jobs based on current filter
    let jobs = allJobs;
    if (currentJobFilter !== 'all') {
        jobs = allJobs.filter(job => job.status === currentJobFilter);
    }
    
    if (jobs.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No jobs match this filter</div>';
        return;
    }

    // Check if we need a full re-render or can do partial updates
    const existingJobCards = container.querySelectorAll('.job-card');
    let shouldDoFullRender = existingJobCards.length !== jobs.length;
    
    // Also check if any job status has changed (requires full re-render)
    if (!shouldDoFullRender) {
        jobs.forEach(job => {
            const existingCard = container.querySelector(`.job-card[data-job-id="${job.id}"]`);
            if (!existingCard) {
                shouldDoFullRender = true;
                return;
            }
            // Check if status changed by comparing class names
            const hasCorrectStatus = existingCard.classList.contains(job.status);
            if (!hasCorrectStatus) {
                shouldDoFullRender = true;
            }
        });
    }
    
    if (!shouldDoFullRender) {
        // Only update existing jobs instead of full re-render
        jobs.forEach(job => {
            updateJobCard(job);
        });
        return;
    }

    // Full render when job list or status changes
    container.innerHTML = jobs.map(job => {
        // Calculate progress based on loss_history
        let progress = 0;
        
        if (job.loss_history?.total && job.loss_history.total.length > 0) {
            const currentEpoch = job.loss_history.total.length;
            const maxEpochs = job.config?.training?.max_epochs || 1000;
            progress = Math.round((currentEpoch / maxEpochs) * 100);
        }
        
        // Check if job has loss history to show
        const hasLossHistory = job.loss_history?.total && job.loss_history.total.length > 0;
        
        // Running jobs are always expanded, others can be toggled
        const isRunning = job.status === 'running';
        const isExpanded = isRunning || expandedJobIds.has(job.id);
        
        // Running jobs should always have a chart container (even if no data yet)
        // so that when loss_history arrives via polling, there's a container to update
        const shouldHaveChartContainer = isRunning || hasLossHistory;
        
        return `
            <div class="job-card ${job.status}" data-job-id="${job.id}">
                <div class="job-header">
                    <div class="job-name">${job.job_name || 'Unnamed Job'}</div>
                    <div class="job-actions">
                        ${hasLossHistory && !isRunning ? `
                            <button class="btn-small btn-expand ${isExpanded ? 'expanded' : ''}" data-job-id="${job.id}">${isExpanded ? '📉 Collapse' : '📊 Expand'}</button>
                        ` : ''}
                        <div class="job-status status-${job.status}">${job.status.toUpperCase()}</div>
                        ${(job.status === 'running' || job.status === 'pending') ? `
                            <button class="btn-small btn-terminate" data-job-id="${job.id}">⏹️ Stop</button>
                        ` : ''}
                        <button class="btn-small btn-delete" data-job-id="${job.id}">🗑️ Delete</button>
                    </div>
                </div>
                <div class="job-info">
                    📁 ${job.roast_file_ids.length} roast files
                </div>
                <div class="job-info">
                    🗓️ ${new Date(job.created_at).toLocaleString()}
                </div>
                ${job.status === 'running' && progress > 0 ? `
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%">
                            ${progress}%
                        </div>
                    </div>
                ` : ''}
                ${job.status === 'completed' ? `
                    <div class="job-info" style="color: #28a745;">
                        ✓ Completed in ${job.duration_seconds}s • Final loss: ${job.loss_history?.total?.slice(-1)[0]?.toFixed(4) || 'N/A'}
                    </div>
                ` : ''}
                ${job.status === 'failed' ? `
                    <div class="error-message">
                        ${job.error_message || 'Training failed'}
                    </div>
                ` : ''}
                ${shouldHaveChartContainer ? `
                    <div class="job-expanded-content" id="job-expanded-${job.id}" style="display: ${isExpanded ? 'block' : 'none'};">
                        <div class="job-loss-chart-container" id="job-loss-chart-${job.id}">
                            ${!hasLossHistory && isRunning ? '<div class="loading"><div class="loading-spinner"></div><div>Waiting for training data...</div></div>' : ''}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
    
    // Plot charts for running jobs (always expanded) and manually expanded jobs after HTML is built
    jobs.forEach(job => {
        const isRunning = job.status === 'running';
        const isExpanded = expandedJobIds.has(job.id);
        const shouldPlot = (isRunning || isExpanded) && job.loss_history;
        
        if (shouldPlot) {
            plotJobLossHistory(job.id, job.loss_history!);
        }
    });
    
    // Add event listeners for expand buttons
    container.querySelectorAll('.btn-expand').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                toggleJobExpanded(jobId);
            }
        });
    });
    
    // Add event listeners for action buttons
    container.querySelectorAll('.btn-terminate').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                const job = allJobs.find(j => j.id === jobId);
                if (job) {
                    await terminateJob(jobId, job.job_name || 'this job');
                }
            }
        });
    });
    
    container.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                const job = allJobs.find(j => j.id === jobId);
                if (job) {
                    await deleteJob(jobId, job.job_name || 'this job');
                }
            }
        });
    });
}

/**
 * Toggle the expanded state of a job card
 * @param jobId - ID of the job to toggle
 */
function toggleJobExpanded(jobId: string): void {
    const expandedContent = document.getElementById(`job-expanded-${jobId}`);
    const expandBtn = document.querySelector(`.btn-expand[data-job-id="${jobId}"]`);
    
    if (!expandedContent || !expandBtn) return;
    
    const isExpanded = expandedJobIds.has(jobId);
    
    if (isExpanded) {
        // Collapse
        expandedJobIds.delete(jobId);
        expandedContent.style.display = 'none';
        expandBtn.textContent = '📊 Expand';
        expandBtn.classList.remove('expanded');
    } else {
        // Expand
        expandedJobIds.add(jobId);
        expandedContent.style.display = 'block';
        expandBtn.textContent = '📉 Collapse';
        expandBtn.classList.add('expanded');
        
        // Plot the loss history
        const job = allJobs.find(j => j.id === jobId);
        if (job && job.loss_history) {
            plotJobLossHistory(jobId, job.loss_history);
        }
    }
}

/**
 * Plot the loss history for a specific job card
 * @param jobId - ID of the job
 * @param lossHistory - Object containing arrays of loss values (total, recon, estim)
 */
function plotJobLossHistory(jobId: string, lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const container = document.getElementById(`job-loss-chart-${jobId}`);
    if (!container) return;
    
    const traces: any[] = [];
    
    // Total loss trace
    if (lossHistory.total && lossHistory.total.length > 0) {
        traces.push({
            y: lossHistory.total,
            name: 'Total Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#8B4513', width: 2 }
        });
    }
    
    // Reconstruction loss trace
    if (lossHistory.recon && lossHistory.recon.length > 0) {
        traces.push({
            y: lossHistory.recon,
            name: 'Reconstruction Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#007bff', width: 1.5 }
        });
    }
    
    // Estimator loss trace
    if (lossHistory.estim && lossHistory.estim.length > 0) {
        traces.push({
            y: lossHistory.estim,
            name: 'Estimator Loss',
            type: 'scatter',
            mode: 'lines',
            line: { color: '#28a745', width: 1.5 }
        });
    }
    
    const layout = {
        title: 'Training Loss History',
        xaxis: { 
            title: 'Epoch',
            gridcolor: '#e0e0e0'
        },
        yaxis: { 
            title: 'Loss', 
            type: 'log' as const,
            gridcolor: '#e0e0e0'
        },
        height: 300,
        margin: { l: 60, r: 30, t: 40, b: 40 },
        plot_bgcolor: '#fafafa',
        paper_bgcolor: '#ffffff',
        legend: {
            x: 1,
            xanchor: 'right' as const,
            y: 1
        }
    };
    
    const config = {
        responsive: true,
        displayModeBar: false
    };
    
    Plotly.newPlot(container, traces, layout, config);
}

/**
 * Initialize job filter buttons
 */
function initJobFilters(): void {
    const filterButtons = document.querySelectorAll('.job-filter-btn');
    
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const status = btn.getAttribute('data-status');
            if (!status) return;
            
            // Update active button
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Update current filter
            currentJobFilter = status;
            
            // Re-display jobs
            displayJobs();
        });
    });
}

/**
 * Terminate a running training job
 * @param jobId - ID of the job to terminate
 * @param jobName - Name of the job (for confirmation dialog)
 */
async function terminateJob(jobId: string, jobName: string): Promise<void> {
    if (!confirm(`Are you sure you want to stop "${jobName}"?\n\nThis will terminate the running training job on Modal.`)) {
        return;
    }

    try {
        const response = await supabase.functions.invoke('terminate-training', {
            body: { jobId: jobId }
        });

        if (response.error) {
            throw new Error(response.error.message || 'Failed to terminate job');
        }

        showMessage(`Successfully terminated "${jobName}"`, 'success');
        await loadJobs();

    } catch (error: any) {
        console.error('Error terminating job:', error);
        showMessage(`Failed to terminate job: ${error.message}`, 'error');
    }
}

/**
 * Delete a training job from the database
 * @param jobId - ID of the job to delete
 * @param jobName - Name of the job (for confirmation dialog)
 */
async function deleteJob(jobId: string, jobName: string): Promise<void> {
    if (!confirm(`Are you sure you want to delete "${jobName}"?\n\nThis action cannot be undone.`)) {
        return;
    }

    try {
        const { error } = await supabase
            .from('training_jobs')
            .delete()
            .eq('id', jobId);

        if (error) throw error;

        showMessage(`Successfully deleted "${jobName}"`, 'success');
        
        // Reload both jobs and models (in case a completed job was deleted)
        await loadJobs();
        await loadModels();

    } catch (error: any) {
        console.error('Error deleting job:', error);
        showMessage(`Failed to delete job: ${error.message}`, 'error');
    }
}

/**
 * Delete a model (completed training job) from the database
 * This also deletes all associated model files from Supabase storage
 * @param modelId - ID of the model to delete
 * @param modelName - Name of the model (for confirmation dialog)
 */
async function deleteModel(modelId: string, modelName: string): Promise<void> {
    if (!confirm(`Are you sure you want to delete "${modelName}"?\n\nThis action cannot be undone and will remove the model from your library and delete all associated files.`)) {
        return;
    }

    try {
        // First, get the training job details to find the storage path
        const { data: jobData, error: jobError } = await supabase
            .from('training_jobs')
            .select('user_id')
            .eq('id', modelId)
            .single();

        if (jobError) throw jobError;

        // Storage path format: {user_id}/jobs/{job_id}/
        const storagePath = `${jobData.user_id}/jobs/${modelId}`;
        
        // Delete all files in the job's storage directory
        // List all files in the directory first
        console.log(`Deleting model files from storage path: ${storagePath}`);
        
        try {
            // List files in the job directory
            const { data: fileList, error: listError } = await supabase
                .storage
                .from('trained-models')
                .list(storagePath, {
                    limit: 1000,
                    sortBy: { column: 'name', order: 'asc' }
                });

            if (listError) {
                console.warn('Error listing files:', listError);
            } else if (fileList && fileList.length > 0) {
                // Delete each file
                const filePaths = fileList.map(file => `${storagePath}/${file.name}`);
                
                // Also check for evaluations subdirectory
                const { data: evalFileList, error: evalListError } = await supabase
                    .storage
                    .from('trained-models')
                    .list(`${storagePath}/evaluations`, {
                        limit: 1000,
                        sortBy: { column: 'name', order: 'asc' }
                    });

                if (!evalListError && evalFileList && evalFileList.length > 0) {
                    const evalFilePaths = evalFileList.map(file => `${storagePath}/evaluations/${file.name}`);
                    filePaths.push(...evalFilePaths);
                }
                
                console.log(`Deleting ${filePaths.length} files from storage`);
                
                const { error: deleteError } = await supabase
                    .storage
                    .from('trained-models')
                    .remove(filePaths);

                if (deleteError) {
                    console.warn('Error deleting some storage files:', deleteError);
                    // Continue anyway - don't fail the entire operation
                }
            }
        } catch (storageError: any) {
            console.warn('Warning: Error deleting storage files:', storageError);
            // Continue with database deletion even if storage deletion fails
        }

        // Delete the training job record from the database
        const { error: dbError } = await supabase
            .from('training_jobs')
            .delete()
            .eq('id', modelId);

        if (dbError) throw dbError;

        showMessage(`Successfully deleted "${modelName}" and all associated files`, 'success');
        
        // Clear the selected model if it was the one deleted
        if (selectedModelId === modelId) {
            selectedModelId = null;
            const titleEl = document.getElementById('inspection-panel-title');
            const emptyEl = document.getElementById('inspection-empty');
            const detailsEl = document.getElementById('inspection-details');
            
            if (titleEl) titleEl.textContent = 'Select a model to inspect';
            if (emptyEl) emptyEl.style.display = 'block';
            if (detailsEl) detailsEl.style.display = 'none';
        }
        
        // Reload models list
        await loadModels();

    } catch (error: any) {
        console.error('Error deleting model:', error);
        showMessage(`Failed to delete model: ${error.message}`, 'error');
    }
}

/**
 * Start periodic refresh of jobs list
 * This keeps the job status and progress updated in real-time
 */
function startJobsRefresh(): void {
    setInterval(() => {
        loadJobs();
        // Also refresh models in case any jobs completed
        loadModels();
    }, 10000); // Refresh every 10 seconds
}

// ========================================
// INITIALIZATION
// ========================================

/**
 * Initialize the training page
 */
(async () => {
    const session = await checkAuth();
    if (session) {
        // Set up sign out handler
        const signOutBtn = document.getElementById('signout-btn');
        if (signOutBtn) {
            signOutBtn.addEventListener('click', signOut);
        }
        
        // Initialize tab switching
        initTabSwitching();
        
        // Initialize roast filters
        initRoastFilters();
        
        // Initialize job filters
        initJobFilters();
        
        // Set up training button handler
        const startTrainingBtn = document.getElementById('start-training-btn');
        if (startTrainingBtn) {
            startTrainingBtn.addEventListener('click', startTraining);
        }
        
        // Load initial data
        await loadModels();
        await loadRoasts();
        await loadJobs();
        
        // Start periodic refresh
        startJobsRefresh();
    }
})();
