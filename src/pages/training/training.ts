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
import { Chart, registerables } from 'chart.js';

// Register Chart.js components
Chart.register(...registerables);

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
    config: TrainingConfig | any; // 'any' added to support both roaster and bean configs
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
let sysidModels: TrainingJob[] = [];         // Available system ID models for bean training
let currentTrainingType: 'system_id' | 'bean' = 'system_id'; // Current training type
let currentModelTypeFilter: 'all' | 'roaster' | 'bean' = 'all'; // Current model type filter

// Chart.js instances - Map of chart container ID to Chart instance
// This allows us to update charts without recreating them
const chartInstances: Map<string, Chart> = new Map();

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Format elapsed time from a start timestamp to current time
 * Returns a human-readable string like "1hr 23min" or "45min" or "2hr 0min"
 * @param startedAt - ISO timestamp string of when the job started
 * @returns Formatted elapsed time string
 */
function formatElapsedTime(startedAt: string | null): string {
    if (!startedAt) return 'N/A';
    
    const startTime = new Date(startedAt).getTime();
    const currentTime = new Date().getTime();
    const elapsedMs = currentTime - startTime;
    
    // Convert milliseconds to minutes
    const elapsedMinutes = Math.floor(elapsedMs / (1000 * 60));
    
    // Calculate hours and remaining minutes
    const hours = Math.floor(elapsedMinutes / 60);
    const minutes = elapsedMinutes % 60;
    
    if (hours > 0) {
        return `${hours}hr ${minutes}min`;
    } else {
        return `${minutes}min`;
    }
}

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
 * Determine if a model is a roaster or bean model based on its configuration
 * Bean models have bean_hidden_dims in their config, roaster models don't
 * @param model - The training job (model) to check
 * @returns 'roaster' or 'bean'
 */
function getModelType(model: TrainingJob): 'roaster' | 'bean' {
    // Check if config has bean_hidden_dims property (bean model)
    // Bean models have a simplified config structure
    if ((model.config as any).bean_hidden_dims) {
        return 'bean';
    }
    // Check if config has the full roaster model structure
    if (model.config.model && model.config.data) {
        return 'roaster';
    }
    // Default to roaster for backward compatibility
    return 'roaster';
}

/**
 * Filter models based on the current model type filter
 * @param models - Array of all models
 * @returns Filtered array of models
 */
function filterModelsByType(models: TrainingJob[]): TrainingJob[] {
    if (currentModelTypeFilter === 'all') {
        return models;
    }
    
    return models.filter(model => getModelType(model) === currentModelTypeFilter);
}

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
        
        const allModels = data as TrainingJob[];
        
        // Apply model type filter
        const models = filterModelsByType(allModels);
        
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
        const modelType = getModelType(model);
        
        // Build config section based on model type
        let configSectionHTML = '';
        
        if (modelType === 'bean') {
            // Bean model - simpler config structure
            const beanConfig = model.config as any;
            configSectionHTML = `
                <div class="detail-section">
                    <h4>Model Configuration</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <div class="detail-label">Model Type</div>
                            <div class="detail-value">Bean Model</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Bean Hidden Dims</div>
                            <div class="detail-value">${beanConfig.bean_hidden_dims ? JSON.stringify(beanConfig.bean_hidden_dims) : 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Learning Rate</div>
                            <div class="detail-value">${beanConfig.training?.lr || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Max Epochs</div>
                            <div class="detail-value">${beanConfig.training?.max_epochs || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Patience</div>
                            <div class="detail-value">${beanConfig.training?.patience || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Scheduler Factor</div>
                            <div class="detail-value">${beanConfig.training?.scheduler_factor || 'N/A'}</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            // Roaster model - full config structure
            configSectionHTML = `
                <div class="detail-section">
                    <h4>Model Configuration</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <div class="detail-label">Model Type</div>
                            <div class="detail-value">Roaster Model (System ID)</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Latent Dimensions</div>
                            <div class="detail-value">${model.config.model?.n_latents || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Roaster Type</div>
                            <div class="detail-value">${model.config.model?.roaster_type || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Estimator Hidden Dim</div>
                            <div class="detail-value">${model.config.model?.estimator_hidden_dim || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Batch Size</div>
                            <div class="detail-value">${model.config.data?.batch_size || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Sequence Length</div>
                            <div class="detail-value">${model.config.data?.sequence_length || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Learning Rate</div>
                            <div class="detail-value">${model.config.training?.lr || 'N/A'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Max Epochs</div>
                            <div class="detail-value">${model.config.training?.max_epochs || 'N/A'}</div>
                        </div>
                    </div>
                </div>
            `;
        }
        
        // Check if evaluation metrics are available
        const evalMetrics = (model as any).evaluation_metrics;
        let evalSectionHTML = '';
        
        if (evalMetrics && evalMetrics.avg_mape !== undefined) {
            evalSectionHTML = `
                <div class="detail-section">
                    <h4>Evaluation Metrics</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <div class="detail-label">Mean Average Percent Error (MAPE)</div>
                            <div class="detail-value" style="font-weight: bold; color: #8B4513;">${evalMetrics.avg_mape.toFixed(2)}%</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Mean Absolute Error (MAE)</div>
                            <div class="detail-value">${evalMetrics.avg_mae.toFixed(2)}°C</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Root Mean Square Error (RMSE)</div>
                            <div class="detail-value">${evalMetrics.avg_rmse.toFixed(2)}°C</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Roasts Evaluated</div>
                            <div class="detail-value">${evalMetrics.num_roasts_evaluated}</div>
                        </div>
                    </div>
                    <div style="margin-top: 10px; padding: 10px; background-color: #f8f9fa; border-radius: 4px; font-size: 13px; color: #666;">
                        <strong>About MAPE:</strong> Mean Average Percent Error measures the open-loop roast reconstruction accuracy across all roasts in the evaluation set. Lower values indicate better model performance.
                    </div>
                </div>
            `;
        }
        
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
            
            ${evalSectionHTML}
            
            ${configSectionHTML}
            
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
 * Plot the loss history for a model using Chart.js
 * @param lossHistory - Object containing arrays of loss values (total, recon, estim)
 */
function plotLossHistory(lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const container = document.getElementById('model-loss-chart');
    if (!container) return;
    
    // Clear existing content and create canvas element
    container.innerHTML = '<canvas id="model-loss-canvas"></canvas>';
    const canvas = document.getElementById('model-loss-canvas') as HTMLCanvasElement;
    if (!canvas) return;
    
    // Destroy existing chart instance if it exists
    const existingChart = chartInstances.get('model-loss-chart');
    if (existingChart) {
        existingChart.destroy();
        chartInstances.delete('model-loss-chart');
    }
    
    // Prepare datasets - Chart.js requires data arrays for each dataset
    const datasets: any[] = [];
    
    // Determine the number of epochs (x-axis length) from the longest array
    const numEpochs = Math.max(
        lossHistory.total?.length || 0,
        lossHistory.recon?.length || 0,
        lossHistory.estim?.length || 0
    );
    
    // Create x-axis labels (epoch numbers)
    const labels = Array.from({ length: numEpochs }, (_, i) => i + 1);
    
    // Total loss dataset
    if (lossHistory.total && lossHistory.total.length > 0) {
        datasets.push({
            label: 'Total Loss',
            data: lossHistory.total,
            borderColor: '#8B4513',
            backgroundColor: 'rgba(139, 69, 19, 0.1)',
            borderWidth: 2,
            pointRadius: 0,  // No point markers for cleaner look
            tension: 0.1     // Slight curve to the line
        });
    }
    
    // Reconstruction loss dataset
    if (lossHistory.recon && lossHistory.recon.length > 0) {
        datasets.push({
            label: 'Reconstruction Loss',
            data: lossHistory.recon,
            borderColor: '#007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1
        });
    }
    
    // Estimator loss dataset
    if (lossHistory.estim && lossHistory.estim.length > 0) {
        datasets.push({
            label: 'Estimator Loss',
            data: lossHistory.estim,
            borderColor: '#28a745',
            backgroundColor: 'rgba(40, 167, 69, 0.1)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1
        });
    }
    
    // Create the Chart.js chart with logarithmic y-axis
    const chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Training Loss History',
                    font: { size: 14 }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Epoch'
                    },
                    grid: {
                        color: '#e0e0e0'
                    }
                },
                y: {
                    type: 'logarithmic',  // Logarithmic scale for loss
                    title: {
                        display: true,
                        text: 'Loss (log scale)'
                    },
                    grid: {
                        color: '#e0e0e0'
                    }
                }
            }
        }
    });
    
    // Store the chart instance for potential updates
    // Type cast to any due to incomplete chartjs-plugin-dragdata type definitions
    chartInstances.set('model-loss-chart', chart as any);
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
        
        // Populate filter dropdowns with available values from the roast data
        populateFilterOptions();
        
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
 * Populate filter dropdowns with unique values from roast data
 * This function extracts unique values for origin, variety, and process
 * from all roasts and populates the corresponding select elements
 */
function populateFilterOptions(): void {
    // Extract unique values for each field
    // Using Sets to automatically handle uniqueness, then converting to sorted arrays
    const origins = new Set<string>();
    const varieties = new Set<string>();
    const processes = new Set<string>();
    
    // Iterate through all roasts to collect unique values
    roasts.forEach(roast => {
        if (roast.origin) origins.add(roast.origin);
        if (roast.variety) varieties.add(roast.variety);
        if (roast.process) processes.add(roast.process);
    });
    
    // Convert Sets to sorted arrays for display
    // Sort alphabetically for easier selection by users
    const sortedOrigins = Array.from(origins).sort();
    const sortedVarieties = Array.from(varieties).sort();
    const sortedProcesses = Array.from(processes).sort();
    
    // Populate origin dropdown
    // Keep the "All origins" option at the top, then add the actual values
    const originSelect = document.getElementById('training-filter-origin') as HTMLSelectElement;
    if (originSelect) {
        // Clear existing options except the first "All origins" option
        while (originSelect.options.length > 1) {
            originSelect.remove(1);
        }
        
        // Add sorted origin options
        sortedOrigins.forEach(origin => {
            const option = document.createElement('option');
            option.value = origin;
            option.textContent = origin;
            originSelect.appendChild(option);
        });
    }
    
    // Populate variety dropdown
    // Keep the "All varieties" option at the top, then add the actual values
    const varietySelect = document.getElementById('training-filter-variety') as HTMLSelectElement;
    if (varietySelect) {
        // Clear existing options except the first "All varieties" option
        while (varietySelect.options.length > 1) {
            varietySelect.remove(1);
        }
        
        // Add sorted variety options
        sortedVarieties.forEach(variety => {
            const option = document.createElement('option');
            option.value = variety;
            option.textContent = variety;
            varietySelect.appendChild(option);
        });
    }
    
    // Populate process dropdown
    // Keep the "All processes" option at the top, then add the actual values
    const processSelect = document.getElementById('training-filter-process') as HTMLSelectElement;
    if (processSelect) {
        // Clear existing options except the first "All processes" option
        while (processSelect.options.length > 1) {
            processSelect.remove(1);
        }
        
        // Add sorted process options
        sortedProcesses.forEach(process => {
            const option = document.createElement('option');
            option.value = process;
            // Capitalize first letter for display
            option.textContent = process.charAt(0).toUpperCase() + process.slice(1);
            processSelect.appendChild(option);
        });
    }
}

/**
 * Apply filters and sorting to the roasts list
 */
function applyRoastFilters(): void {
    const originFilter = (document.getElementById('training-filter-origin') as HTMLSelectElement)?.value || '';
    const varietyFilter = (document.getElementById('training-filter-variety') as HTMLSelectElement)?.value || '';
    const processFilter = (document.getElementById('training-filter-process') as HTMLSelectElement)?.value || '';
    const sortBy = (document.getElementById('training-sort-by') as HTMLSelectElement)?.value || 'roast_date_desc';
    
    // Filter roasts
    // For select dropdowns, we do exact matching (not substring matching like before)
    filteredRoasts = roasts.filter(roast => {
        const matchesOrigin = !originFilter || roast.origin === originFilter;
        const matchesVariety = !varietyFilter || roast.variety === varietyFilter;
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
// BEAN TRAINING SUPPORT
// ========================================

/**
 * Load available System ID models for bean training
 * These are completed training jobs with roaster models (not bean models)
 */
async function loadSysidModels(): Promise<void> {
    try {
        // Query for completed training jobs
        const { data, error } = await supabase
            .from('training_jobs')
            .select('*')
            .eq('status', 'completed')
            .order('completed_at', { ascending: false });
        
        if (error) throw error;
        
        // Filter to only include roaster models (System ID models)
        // Bean models should not be used as base models for other bean training
        const allModels = data as TrainingJob[];
        sysidModels = allModels.filter(model => getModelType(model) === 'roaster');
        
        populateSysidModelSelect();
        
    } catch (error: any) {
        console.error('Error loading system ID models:', error);
        const select = document.getElementById('sysidModelSelect') as HTMLSelectElement;
        if (select) {
            select.innerHTML = '<option value="">Error loading models</option>';
        }
    }
}

/**
 * Populate the System ID model selector dropdown
 */
function populateSysidModelSelect(): void {
    const select = document.getElementById('sysidModelSelect') as HTMLSelectElement;
    if (!select) return;
    
    if (sysidModels.length === 0) {
        select.innerHTML = '<option value="">No system ID models available</option>';
        return;
    }
    
    select.innerHTML = '<option value="">Select a system ID model...</option>' +
        sysidModels.map(model => {
            const modelName = model.job_name || 'Unnamed Model';
            const date = new Date(model.completed_at!).toLocaleDateString();
            return `<option value="${model.id}">${modelName} (${date})</option>`;
        }).join('');
}

/**
 * Handle training type change
 * Shows/hides bean-specific fields based on selection
 */
function handleTrainingTypeChange(): void {
    const trainingTypeSelect = document.getElementById('trainingType') as HTMLSelectElement;
    if (!trainingTypeSelect) return;
    
    const trainingType = trainingTypeSelect.value as 'system_id' | 'bean';
    currentTrainingType = trainingType;
    
    const beanTrainingFields = document.getElementById('beanTrainingFields');
    const dataConfigSection = document.querySelector('.config-section') as HTMLDetailsElement;
    const modelConfigSection = document.querySelectorAll('.config-section')[1] as HTMLDetailsElement;
    const lossConfigSection = document.querySelectorAll('.config-section')[2] as HTMLDetailsElement;
    
    // Get variety filter elements for styling
    const varietyRequiredIndicator = document.getElementById('variety-required-indicator');
    
    if (trainingType === 'bean') {
        // Show bean-specific fields
        if (beanTrainingFields) {
            beanTrainingFields.style.display = 'block';
        }
        
        // Show variety required indicator (red asterisk only)
        if (varietyRequiredIndicator) varietyRequiredIndicator.style.display = 'inline';
        
        // Hide system ID configuration sections (they're frozen for bean training)
        // Only show basic training configuration
        if (dataConfigSection) dataConfigSection.style.display = 'none';
        if (modelConfigSection) modelConfigSection.style.display = 'none';
        if (lossConfigSection) lossConfigSection.style.display = 'none';
        
    } else {
        // Hide bean-specific fields
        if (beanTrainingFields) {
            beanTrainingFields.style.display = 'none';
        }
        
        // Hide variety required indicator
        if (varietyRequiredIndicator) varietyRequiredIndicator.style.display = 'none';
        
        // Show all configuration sections for system ID training
        if (dataConfigSection) dataConfigSection.style.display = 'block';
        if (modelConfigSection) modelConfigSection.style.display = 'block';
        if (lossConfigSection) lossConfigSection.style.display = 'block';
    }
}

/**
 * Initialize training type selector
 */
function initTrainingTypeSelector(): void {
    const trainingTypeSelect = document.getElementById('trainingType');
    if (trainingTypeSelect) {
        trainingTypeSelect.addEventListener('change', handleTrainingTypeChange);
        // Initialize the view
        handleTrainingTypeChange();
    }
}

/**
 * Start bean training job
 * Bean training uses a pre-trained system ID model and trains only the bean-specific parameters
 */
async function startBeanTraining(): Promise<void> {
    try {
        // Validation: Check system ID model is selected
        const sysidModelSelect = document.getElementById('sysidModelSelect') as HTMLSelectElement;
        if (!sysidModelSelect || !sysidModelSelect.value) {
            showMessage('Please select a System ID model', 'error');
            return;
        }
        
        // Validation: Check bean variety is provided via the variety filter
        const varietyFilterSelect = document.getElementById('training-filter-variety') as HTMLSelectElement;
        if (!varietyFilterSelect || !varietyFilterSelect.value) {
            showMessage('Please select a bean variety using the Variety filter in the data selection section', 'error');
            return;
        }
        
        const beanVariety = varietyFilterSelect.value;
        
        // Validation: Check that all selected roasts have the same variety
        // This ensures we're training on a single bean type
        const selectedRoasts = roasts.filter(r => selectedRoastIds.has(r.id));
        const varieties = new Set(selectedRoasts.map(r => r.variety?.toLowerCase().trim()));
        
        if (varieties.size === 0) {
            showMessage('No roasts selected. Please select roasts with the specified variety.', 'error');
            return;
        }
        
        if (varieties.size > 1) {
            showMessage('Selected roasts contain multiple varieties. For bean training, all roasts must be of the same variety.', 'error');
            return;
        }
        
        // Check that the selected variety matches the filter
        const selectedVariety = Array.from(varieties)[0];
        if (selectedVariety !== beanVariety.toLowerCase().trim()) {
            showMessage(`Selected roasts have variety "${selectedVariety}" but filter shows "${beanVariety}". Please ensure the filter matches the selected roasts.`, 'error');
            return;
        }
        
        const sysidModelJobId = sysidModelSelect.value;
        
        // Check if we're warm starting from a checkpoint by reading from the checkpoint indicator
        const checkpointIndicator = document.getElementById('checkpointIndicator');
        const checkpointJobId = checkpointIndicator?.getAttribute('data-checkpoint-job-id') || null;
        
        // Clear the checkpoint indicator after reading it (training has been initiated)
        if (checkpointJobId) {
            clearCheckpoint();
        }
        
        // Create bean training configuration (simplified - only training params needed)
        const beanConfig = {
            bean_hidden_dims: [16],
            training: {
                lr: parseFloat((document.getElementById('learningRate') as HTMLInputElement).value),
                max_epochs: parseInt((document.getElementById('maxEpochs') as HTMLInputElement).value),
                patience: parseInt((document.getElementById('patience') as HTMLInputElement).value),
                plot_interval: 10,
                scheduler_factor: parseFloat((document.getElementById('schedulerFactor') as HTMLInputElement).value),
                scheduler_patience: parseInt((document.getElementById('schedulerPatience') as HTMLInputElement).value),
                scheduler_min_lr: parseFloat((document.getElementById('schedulerMinLr') as HTMLInputElement).value),
                scheduler_verbose: (document.getElementById('schedulerVerbose') as HTMLInputElement).checked
            }
        };
        
        // Create job name
        const jobName = (document.getElementById('jobName') as HTMLInputElement).value || 
                       `${beanVariety} Bean Model ${new Date().toLocaleString()}`;
        
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
                config: beanConfig as any, // Bean config structure is different but will be handled
                roast_file_ids: Array.from(selectedRoastIds)
            })
            .select()
            .single();
        
        if (jobError) throw jobError;
        
        showMessage('Bean training job created! Triggering Modal...', 'info');
        
        // Call Supabase Edge Function for bean training
        const response = await supabase.functions.invoke('trigger-bean-training', {
            body: {
                jobId: job.id,
                sysidModelJobId: sysidModelJobId,
                beanVariety: beanVariety,
                roastFileIds: Array.from(selectedRoastIds),
                config: beanConfig,
                checkpointJobId: checkpointJobId  // Pass checkpoint job ID for warm starting
            }
        });
        
        if (response.error) throw response.error;
        
        showMessage(`Bean training started successfully for ${beanVariety}! Check the jobs panel for progress.`, 'success');
        
        // Reset form
        selectedRoastIds.clear();
        displayRoasts();
        (document.getElementById('jobName') as HTMLInputElement).value = '';
        varietyFilterSelect.selectedIndex = 0; // Reset to "All varieties"
        sysidModelSelect.selectedIndex = 0;
        
        // Also clear the filter to reset the view
        applyRoastFilters();
        
        // Reload jobs list
        loadJobs();
        
    } catch (error: any) {
        console.error('Error starting bean training:', error);
        showMessage(`Failed to start bean training: ${error.message}`, 'error');
    }
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
    
    // Check if we're doing bean training
    if (currentTrainingType === 'bean') {
        await startBeanTraining();
        return;
    }

    // System ID training logic
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

        // Check if we're warm starting from a checkpoint by reading from the checkpoint indicator
        const checkpointIndicator = document.getElementById('checkpointIndicator');
        const checkpointJobId = checkpointIndicator?.getAttribute('data-checkpoint-job-id') || null;
        
        // Clear the checkpoint indicator after reading it (training has been initiated)
        if (checkpointJobId) {
            clearCheckpoint();
        }

        // Call Supabase Edge Function to trigger Modal
        const response = await supabase.functions.invoke('trigger-training', {
            body: {
                jobId: job.id,
                roastFileIds: Array.from(selectedRoastIds),
                config: config,
                checkpointJobId: checkpointJobId
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
    
    // Update progress indicator for running jobs
    if (job.status === 'running' && job.loss_history?.total && job.loss_history.total.length > 0) {
        const currentEpoch = job.loss_history.total.length;
        const maxEpochs = job.config?.training?.max_epochs || 1000;
        const elapsedTime = formatElapsedTime(job.started_at);
        
        // Find and update the progress indicator text (including the clock emoji)
        // If it doesn't exist, create it (this handles the case where job started running without loss history)
        let progressIndicator = jobCard.querySelector('.progress-indicator') as HTMLElement;
        if (progressIndicator) {
            // Update existing indicator
            progressIndicator.textContent = `⏱️ Epoch: ${currentEpoch} (${maxEpochs} maximum) - Elapsed time: ${elapsedTime}`;
        } else {
            // Create new indicator element if it doesn't exist yet
            // This happens when a job transitions to 'running' before loss_history is available
            progressIndicator = document.createElement('div');
            progressIndicator.className = 'job-info progress-indicator';
            progressIndicator.style.color = '#007bff';
            progressIndicator.style.fontWeight = '500';
            progressIndicator.textContent = `⏱️ Epoch: ${currentEpoch} (${maxEpochs} maximum) - Elapsed time: ${elapsedTime}`;
            
            // Insert after the creation date info (the last .job-info element before any status messages)
            const jobInfoElements = jobCard.querySelectorAll('.job-info');
            const lastJobInfo = jobInfoElements[jobInfoElements.length - 1];
            if (lastJobInfo && lastJobInfo.parentNode) {
                lastJobInfo.parentNode.insertBefore(progressIndicator, lastJobInfo.nextSibling);
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
 * Update the Chart.js chart data without destroying and recreating the plot
 * This prevents flickering for running jobs
 * @param jobId - ID of the job
 * @param lossHistory - Updated loss history data
 */
function updateJobLossChart(jobId: string, lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const chartKey = `job-loss-chart-${jobId}`;
    const existingChart = chartInstances.get(chartKey);
    
    if (existingChart) {
        // Update existing chart data efficiently
        // Determine the number of epochs from the longest array
        const numEpochs = Math.max(
            lossHistory.total?.length || 0,
            lossHistory.recon?.length || 0,
            lossHistory.estim?.length || 0
        );
        
        // Update x-axis labels (epoch numbers)
        existingChart.data.labels = Array.from({ length: numEpochs }, (_, i) => i + 1);
        
        // Update datasets
        let datasetIndex = 0;
        
        if (lossHistory.total && lossHistory.total.length > 0) {
            if (existingChart.data.datasets[datasetIndex]) {
                existingChart.data.datasets[datasetIndex].data = lossHistory.total;
            }
            datasetIndex++;
        }
        
        if (lossHistory.recon && lossHistory.recon.length > 0) {
            if (existingChart.data.datasets[datasetIndex]) {
                existingChart.data.datasets[datasetIndex].data = lossHistory.recon;
            }
            datasetIndex++;
        }
        
        if (lossHistory.estim && lossHistory.estim.length > 0) {
            if (existingChart.data.datasets[datasetIndex]) {
                existingChart.data.datasets[datasetIndex].data = lossHistory.estim;
            }
        }
        
        // Update the chart without full re-render
        existingChart.update('none'); // 'none' mode = no animation for performance
    } else {
        // Chart doesn't exist yet, create it
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
        // Calculate current epoch and max epochs for running jobs
        let currentEpoch = 0;
        let maxEpochs = job.config?.training?.max_epochs || 1000;
        let elapsedTime = 'N/A';
        
        if (job.loss_history?.total && job.loss_history.total.length > 0) {
            currentEpoch = job.loss_history.total.length;
            elapsedTime = formatElapsedTime(job.started_at);
        }
        
        // Check if job has loss history to show
        const hasLossHistory = job.loss_history?.total && job.loss_history.total.length > 0;
        
        // All jobs can be manually expanded (to see config and loss history)
        const isRunning = job.status === 'running';
        const isExpanded = expandedJobIds.has(job.id);
        
        // Determine what to show in expanded section
        const hasChartToShow = isRunning || hasLossHistory;
        
        return `
            <div class="job-card ${job.status}" data-job-id="${job.id}">
                <div class="job-header">
                    <div class="job-name">${job.job_name || 'Unnamed Job'}</div>
                    <div class="job-actions">
                        <button class="btn-small btn-expand ${isExpanded ? 'expanded' : ''}" data-job-id="${job.id}" title="${isExpanded ? 'Collapse' : 'Expand to view details'}">
                            ${isExpanded ? '📉 Collapse' : '📊 Expand'}
                        </button>
                        <div class="job-status status-${job.status}">${job.status.toUpperCase()}</div>
                        ${job.status === 'completed' ? `
                            <button class="btn-small btn-load-checkpoint" data-job-id="${job.id}" title="Start new training job from this checkpoint">⚡ Load Checkpoint</button>
                        ` : (job.status === 'running' || job.status === 'pending') ? `
                            <button class="btn-small btn-terminate" data-job-id="${job.id}">⏹️ Stop</button>
                        ` : `
                            <button class="btn-small btn-delete" data-job-id="${job.id}">🗑️ Delete</button>
                        `}
                    </div>
                </div>
                <div class="job-info">
                    📁 ${job.roast_file_ids.length} roast files
                </div>
                <div class="job-info">
                    🗓️ ${new Date(job.created_at).toLocaleString()}
                </div>
                ${job.status === 'running' && currentEpoch > 0 ? `
                    <div class="job-info progress-indicator" style="color: #007bff; font-weight: 500;">
                        ⏱️ Epoch: ${currentEpoch} (${maxEpochs} maximum) - Elapsed time: ${elapsedTime}
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
                <div class="job-expanded-content" id="job-expanded-${job.id}" style="display: ${isExpanded ? 'block' : 'none'};">
                    ${hasChartToShow ? `
                        <div class="job-loss-chart-container" id="job-loss-chart-${job.id}"></div>
                    ` : ''}
                    <div class="job-config-section">
                        <div class="job-config-actions">
                            <button class="btn-small btn-view-config" data-job-id="${job.id}" title="View full configuration">
                                📋 View Configuration
                            </button>
                            <button class="btn-small btn-load-config" data-job-id="${job.id}" title="Load this configuration into the form">
                                📥 Load Configuration
                            </button>
                        </div>
                        <div class="job-config-details" id="job-config-${job.id}" style="display: none;"></div>
                    </div>
                </div>
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
    
    // Add event listeners for view configuration buttons
    container.querySelectorAll('.btn-view-config').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                toggleJobConfigView(jobId);
            }
        });
    });
    
    // Add event listeners for load configuration buttons
    container.querySelectorAll('.btn-load-config').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                loadJobConfigIntoForm(jobId);
            }
        });
    });
    
    // Add event listeners for load checkpoint buttons (completed jobs only)
    container.querySelectorAll('.btn-load-checkpoint').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const jobId = (e.target as HTMLElement).getAttribute('data-job-id');
            if (jobId) {
                const job = allJobs.find(j => j.id === jobId);
                if (job) {
                    await loadCheckpointAndStartTraining(jobId, job.job_name || 'this model');
                }
            }
        });
    });
}

/**
 * Load a checkpoint from a completed training job
 * This allows warm starting from a previous training session
 * @param checkpointJobId - ID of the completed job to load checkpoint from
 * @param jobName - Name of the job (for user messages)
 */
async function loadCheckpointAndStartTraining(checkpointJobId: string, jobName: string): Promise<void> {
    const job = allJobs.find(j => j.id === checkpointJobId);
    if (!job) {
        showMessage('Job not found', 'error');
        return;
    }
    
    // Type assertion: even though UI only shows this button for completed jobs,
    // we add this defensive check for robustness
    if ((job.status as string) !== 'completed') {
        showMessage('Can only load checkpoints from completed training jobs', 'error');
        return;
    }
    
    try {
        // Load the configuration into the form
        loadJobConfigIntoForm(checkpointJobId);
        
        // Also pre-select the same roasts that were used in the original training
        // This is helpful but users can modify the selection if needed
        selectedRoastIds.clear();
        job.roast_file_ids.forEach(id => selectedRoastIds.add(id));
        displayRoasts();
        
        // Switch to training view
        const trainingTab = document.querySelector('.view-tab[data-view="training"]') as HTMLElement;
        if (trainingTab && !trainingTab.classList.contains('active')) {
            trainingTab.click();
        }
        
        // Show checkpoint indicator
        showCheckpointIndicator(checkpointJobId, jobName);
        
        // Freeze model architecture fields (data config and model config)
        freezeModelArchitecture(true);
        
        // Scroll to configuration
        const configPanel = document.querySelector('.config-panel');
        if (configPanel) {
            configPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        
        showMessage(`Checkpoint loaded from "${jobName}"! Model architecture is frozen. You can modify training parameters and data, then click "Start Training" to continue from this checkpoint.`, 'success');
        
    } catch (error: any) {
        console.error('Error loading checkpoint:', error);
        showMessage(`Failed to load checkpoint: ${error.message}`, 'error');
    }
}

/**
 * Show the checkpoint indicator with the loaded checkpoint information
 * @param checkpointJobId - ID of the checkpoint job
 * @param jobName - Name of the checkpoint job
 */
function showCheckpointIndicator(checkpointJobId: string, jobName: string): void {
    const indicator = document.getElementById('checkpointIndicator');
    const checkpointNameEl = document.getElementById('checkpointName');
    
    if (indicator && checkpointNameEl) {
        indicator.style.display = 'block';
        indicator.setAttribute('data-checkpoint-job-id', checkpointJobId);
        checkpointNameEl.textContent = `Loading from: ${jobName}`;
    }
}

/**
 * Clear the checkpoint indicator and unfreeze model architecture
 */
function clearCheckpoint(): void {
    const indicator = document.getElementById('checkpointIndicator');
    
    if (indicator) {
        indicator.style.display = 'none';
        indicator.removeAttribute('data-checkpoint-job-id');
    }
    
    // Unfreeze model architecture fields
    freezeModelArchitecture(false);
    
    showMessage('Checkpoint cleared. You can now modify all model parameters.', 'info');
}

/**
 * Freeze or unfreeze model architecture configuration fields
 * When loading from a checkpoint, the model architecture must remain unchanged
 * @param freeze - Whether to freeze (true) or unfreeze (false) the fields
 */
function freezeModelArchitecture(freeze: boolean): void {
    // Data configuration fields
    const dataConfigFields = ['batchSize', 'sequenceLength', 'stride', 'delayHorizon', 'delayPoints'];
    
    // Model configuration fields
    const modelConfigFields = ['nLatents', 'estimatorHidden'];
    
    // Loss & regularization fields
    const lossConfigFields = ['cbWeight', 'chargeWeight', 'airTempWeight'];
    
    // Freeze/unfreeze data and model architecture fields
    [...dataConfigFields, ...modelConfigFields, ...lossConfigFields].forEach(fieldId => {
        const field = document.getElementById(fieldId) as HTMLInputElement;
        if (field) {
            field.disabled = freeze;
            if (freeze) {
                field.style.backgroundColor = '#f0f0f0';
                field.style.cursor = 'not-allowed';
            } else {
                field.style.backgroundColor = '';
                field.style.cursor = '';
            }
        }
    });
    
    // Add visual indicator to frozen sections
    const dataConfigSection = document.querySelector('.config-section') as HTMLDetailsElement;
    const modelConfigSection = document.querySelectorAll('.config-section')[1] as HTMLDetailsElement;
    const lossConfigSection = document.querySelectorAll('.config-section')[2] as HTMLDetailsElement;
    
    [dataConfigSection, modelConfigSection, lossConfigSection].forEach(section => {
        if (section) {
            if (freeze) {
                section.style.opacity = '0.7';
                const summary = section.querySelector('summary');
                if (summary) {
                    summary.style.color = '#666';
                }
            } else {
                section.style.opacity = '';
                const summary = section.querySelector('summary');
                if (summary) {
                    summary.style.color = '';
                }
            }
        }
    });
}

/**
 * Toggle the visibility of the job configuration details
 * @param jobId - ID of the job
 */
function toggleJobConfigView(jobId: string): void {
    const configDetails = document.getElementById(`job-config-${jobId}`);
    const viewBtn = document.querySelector(`.btn-view-config[data-job-id="${jobId}"]`) as HTMLElement;
    
    if (!configDetails || !viewBtn) return;
    
    const isVisible = configDetails.style.display !== 'none';
    
    if (isVisible) {
        // Hide configuration
        configDetails.style.display = 'none';
        viewBtn.textContent = '📋 View Configuration';
    } else {
        // Show configuration - build the config display
        const job = allJobs.find(j => j.id === jobId);
        if (!job) return;
        
        const modelType = getModelType(job);
        
        // Format configuration as readable JSON
        configDetails.innerHTML = `
            <div style="background: #2c2c2c; color: #f8f8f2; padding: 15px; border-radius: 6px; overflow-x: auto; margin-top: 10px;">
                <div style="margin-bottom: 10px; font-weight: bold; color: #8B4513; font-size: 14px;">
                    Model Type: ${modelType === 'bean' ? 'Bean Model' : 'Roaster Model (System ID)'}
                </div>
                <pre style="margin: 0; font-family: 'Courier New', monospace; font-size: 12px; line-height: 1.5;">${JSON.stringify(job.config, null, 2)}</pre>
            </div>
        `;
        configDetails.style.display = 'block';
        viewBtn.textContent = '📋 Hide Configuration';
    }
}

/**
 * Load a job's configuration into the training form
 * This allows users to quickly create a new training job based on an existing configuration
 * @param jobId - ID of the job whose configuration to load
 */
function loadJobConfigIntoForm(jobId: string): void {
    const job = allJobs.find(j => j.id === jobId);
    if (!job) {
        showMessage('Job not found', 'error');
        return;
    }
    
    const modelType = getModelType(job);
    
    try {
        if (modelType === 'bean') {
            // Bean model configuration
            const beanConfig = job.config as any;
            
            // Switch to bean training mode
            const trainingTypeSelect = document.getElementById('trainingType') as HTMLSelectElement;
            if (trainingTypeSelect) {
                trainingTypeSelect.value = 'bean';
                handleTrainingTypeChange();
            }
            
            // Load training parameters
            if (beanConfig.training) {
                setInputValue('learningRate', beanConfig.training.lr);
                setInputValue('maxEpochs', beanConfig.training.max_epochs);
                setInputValue('patience', beanConfig.training.patience);
                setInputValue('schedulerFactor', beanConfig.training.scheduler_factor);
                setInputValue('schedulerPatience', beanConfig.training.scheduler_patience);
                setInputValue('schedulerMinLr', beanConfig.training.scheduler_min_lr);
                setCheckboxValue('schedulerVerbose', beanConfig.training.scheduler_verbose);
            }
            
            showMessage('Bean model configuration loaded into form. Note: You still need to select a System ID model and bean variety.', 'success');
            
        } else {
            // Roaster model (System ID) configuration
            const config = job.config;
            
            // Switch to system ID training mode
            const trainingTypeSelect = document.getElementById('trainingType') as HTMLSelectElement;
            if (trainingTypeSelect) {
                trainingTypeSelect.value = 'system_id';
                handleTrainingTypeChange();
            }
            
            // Load data configuration
            if (config.data) {
                setInputValue('batchSize', config.data.batch_size);
                setInputValue('sequenceLength', config.data.sequence_length);
                setInputValue('stride', config.data.stride);
                if (config.data.delay) {
                    setInputValue('delayHorizon', config.data.delay.time_horizon);
                    setInputValue('delayPoints', config.data.delay.num_points);
                }
            }
            
            // Load model configuration
            if (config.model) {
                setInputValue('nLatents', config.model.n_latents);
                setInputValue('estimatorHidden', config.model.estimator_hidden_dim);
            }
            
            // Load training configuration
            if (config.training) {
                setInputValue('learningRate', config.training.lr);
                setInputValue('maxEpochs', config.training.max_epochs);
                setInputValue('patience', config.training.patience);
                setInputValue('cbWeight', config.training.cb_weight);
                setInputValue('chargeWeight', config.training.charge_weight);
                setInputValue('airTempWeight', config.training.air_temp_weight);
                setInputValue('schedulerFactor', config.training.scheduler_factor);
                setInputValue('schedulerPatience', config.training.scheduler_patience);
                setInputValue('schedulerMinLr', config.training.scheduler_min_lr);
                setCheckboxValue('schedulerVerbose', config.training.scheduler_verbose);
            }
            
            showMessage('Configuration loaded successfully! You can now select roasts and start a new training job with these parameters.', 'success');
        }
        
        // Switch to the training view if not already there
        const trainingTab = document.querySelector('.view-tab[data-view="training"]') as HTMLElement;
        if (trainingTab && !trainingTab.classList.contains('active')) {
            trainingTab.click();
        }
        
        // Scroll to the configuration form
        const configPanel = document.querySelector('.config-panel');
        if (configPanel) {
            configPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        
    } catch (error: any) {
        console.error('Error loading configuration:', error);
        showMessage(`Failed to load configuration: ${error.message}`, 'error');
    }
}

/**
 * Helper function to safely set input value
 * @param elementId - ID of the input element
 * @param value - Value to set
 */
function setInputValue(elementId: string, value: any): void {
    const element = document.getElementById(elementId) as HTMLInputElement;
    if (element && value !== undefined && value !== null) {
        element.value = value.toString();
    }
}

/**
 * Helper function to safely set checkbox value
 * @param elementId - ID of the checkbox element
 * @param checked - Whether the checkbox should be checked
 */
function setCheckboxValue(elementId: string, checked: boolean): void {
    const element = document.getElementById(elementId) as HTMLInputElement;
    if (element) {
        element.checked = checked;
    }
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
 * Plot the loss history for a specific job card using Chart.js
 * @param jobId - ID of the job
 * @param lossHistory - Object containing arrays of loss values (total, recon, estim)
 */
function plotJobLossHistory(jobId: string, lossHistory: { total?: number[], recon?: number[], estim?: number[] }): void {
    const container = document.getElementById(`job-loss-chart-${jobId}`);
    if (!container) return;
    
    // Clear existing content and create canvas element
    const canvasId = `job-loss-canvas-${jobId}`;
    container.innerHTML = `<canvas id="${canvasId}"></canvas>`;
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) return;
    
    // Destroy existing chart instance if it exists
    const chartKey = `job-loss-chart-${jobId}`;
    const existingChart = chartInstances.get(chartKey);
    if (existingChart) {
        existingChart.destroy();
        chartInstances.delete(chartKey);
    }
    
    // Prepare datasets
    const datasets: any[] = [];
    
    // Determine the number of epochs (x-axis length) from the longest array
    const numEpochs = Math.max(
        lossHistory.total?.length || 0,
        lossHistory.recon?.length || 0,
        lossHistory.estim?.length || 0
    );
    
    // Create x-axis labels (epoch numbers)
    const labels = Array.from({ length: numEpochs }, (_, i) => i + 1);
    
    // Total loss dataset
    if (lossHistory.total && lossHistory.total.length > 0) {
        datasets.push({
            label: 'Total Loss',
            data: lossHistory.total,
            borderColor: '#8B4513',
            backgroundColor: 'rgba(139, 69, 19, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.1
        });
    }
    
    // Reconstruction loss dataset
    if (lossHistory.recon && lossHistory.recon.length > 0) {
        datasets.push({
            label: 'Reconstruction Loss',
            data: lossHistory.recon,
            borderColor: '#007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1
        });
    }
    
    // Estimator loss dataset
    if (lossHistory.estim && lossHistory.estim.length > 0) {
        datasets.push({
            label: 'Estimator Loss',
            data: lossHistory.estim,
            borderColor: '#28a745',
            backgroundColor: 'rgba(40, 167, 69, 0.1)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1
        });
    }
    
    // Create the Chart.js chart
    const chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,  // Disable animation for better performance with updates
            plugins: {
                title: {
                    display: true,
                    text: 'Training Loss History',
                    font: { size: 13 }
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: { size: 11 },
                        boxWidth: 12
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Epoch',
                        font: { size: 11 }
                    },
                    grid: {
                        color: '#e0e0e0'
                    },
                    ticks: {
                        font: { size: 10 }
                    }
                },
                y: {
                    type: 'logarithmic',
                    title: {
                        display: true,
                        text: 'Loss (log scale)',
                        font: { size: 11 }
                    },
                    grid: {
                        color: '#e0e0e0'
                    },
                    ticks: {
                        font: { size: 10 }
                    }
                }
            }
        }
    });
    
    // Store the chart instance for updates
    // Type cast to any due to incomplete chartjs-plugin-dragdata type definitions
    chartInstances.set(chartKey, chart as any);
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
        // Immediately update UI to show termination in progress
        const jobCard = document.querySelector(`.job-card[data-job-id="${jobId}"]`);
        if (jobCard) {
            // Update status badge
            const statusBadge = jobCard.querySelector('.job-status');
            if (statusBadge) {
                statusBadge.textContent = 'TERMINATING...';
                statusBadge.className = 'job-status status-pending';
            }
            
            // Disable and update the stop button
            const stopButton = jobCard.querySelector('.btn-terminate') as HTMLButtonElement;
            if (stopButton) {
                stopButton.disabled = true;
                stopButton.textContent = '⏳ Terminating...';
                stopButton.style.opacity = '0.6';
                stopButton.style.cursor = 'not-allowed';
            }
            
            // Update progress indicator if it exists
            const progressIndicator = jobCard.querySelector('.progress-indicator');
            if (progressIndicator) {
                progressIndicator.textContent = '⏳ Termination requested - waiting for server response...';
                (progressIndicator as HTMLElement).style.color = '#ffc107';
            }
        }

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
        
        // Reload jobs to restore correct state on error
        await loadJobs();
    }
}

/**
 * Delete a training job from the database
 * IMPORTANT: Completed jobs cannot be deleted from the jobs view - they must be deleted from the Model Library
 * This preserves the ability to warm start from completed training jobs
 * For non-completed jobs: Deletes both database record and storage files
 * @param jobId - ID of the job to delete
 * @param jobName - Name of the job (for confirmation dialog)
 */
async function deleteJob(jobId: string, jobName: string): Promise<void> {
    // Find the job to check its status
    const job = allJobs.find(j => j.id === jobId);
    if (!job) {
        showMessage('Job not found', 'error');
        return;
    }
    
    // PREVENT DELETION OF COMPLETED JOBS
    // Completed jobs must be deleted from the Model Library to ensure checkpoint preservation
    if (job.status === 'completed') {
        showMessage('Completed training jobs cannot be deleted here. Please delete from the Model Library if needed.', 'error');
        return;
    }
    
    // Confirmation message for non-completed jobs
    const confirmMessage = `Are you sure you want to delete "${jobName}"?\n\nThis action cannot be undone and will remove the job record and any associated partial files.`;
    
    if (!confirm(confirmMessage)) {
        return;
    }

    try {
        // Only delete storage files for non-completed jobs
        // Completed jobs have valuable model artifacts that should be preserved
        // Type assertion: even though UI only shows delete button for non-completed jobs,
        // we add this defensive check for robustness
        if ((job.status as string) !== 'completed') {
            // Get the training job details to find the storage path
            const { data: jobData, error: jobError } = await supabase
                .from('training_jobs')
                .select('user_id')
                .eq('id', jobId)
                .single();

            if (jobError) throw jobError;

        // Storage path format: {user_id}/jobs/{job_id}/
        const storagePath = `${jobData.user_id}/jobs/${jobId}`;
        
        // Delete all files in the job's storage directory
        console.log(`Deleting incomplete job files from storage path: ${storagePath}`);
        
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
                
                // Also check for checkpoints subdirectory (this was missing!)
                const { data: checkpointFileList, error: checkpointListError } = await supabase
                    .storage
                    .from('trained-models')
                    .list(`${storagePath}/checkpoints`, {
                        limit: 1000,
                        sortBy: { column: 'name', order: 'asc' }
                    });

                if (!checkpointListError && checkpointFileList && checkpointFileList.length > 0) {
                    const checkpointFilePaths = checkpointFileList.map(file => `${storagePath}/checkpoints/${file.name}`);
                    filePaths.push(...checkpointFilePaths);
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
        } else {
            console.log(`Job ${jobId} is completed - preserving model files in storage`);
        }

        // Delete the training job record from the database
        const { error: dbError } = await supabase
            .from('training_jobs')
            .delete()
            .eq('id', jobId);

        if (dbError) throw dbError;

        // Type assertion: for success message, check status as string
        const successMessage = (job.status as string) === 'completed' 
            ? `Successfully removed "${jobName}" from jobs list` 
            : `Successfully deleted "${jobName}" and cleaned up associated files`;
        
        showMessage(successMessage, 'success');
        
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
    try {
        // First, check if any recipes reference this model
        // The recipes table has foreign key constraints on roaster_model_id and bean_model_id
        // that prevent deletion if recipes exist (ON DELETE RESTRICT)
        const { data: recipesUsingModel, error: recipesCheckError } = await supabase
            .from('recipes')
            .select('id, name')
            .or(`roaster_model_id.eq.${modelId},bean_model_id.eq.${modelId}`);

        if (recipesCheckError) {
            console.warn('Error checking for recipes:', recipesCheckError);
            // Continue anyway - the deletion will fail if there are recipes
        }

        // Build confirmation message based on whether recipes exist
        let confirmMessage = `Are you sure you want to delete "${modelName}"?\n\nThis action cannot be undone and will remove the model from your library and delete all associated files.`;
        
        if (recipesUsingModel && recipesUsingModel.length > 0) {
            const recipeNames = recipesUsingModel.map(r => r.name).join(', ');
            confirmMessage = `Warning: This model is being used by ${recipesUsingModel.length} recipe(s): ${recipeNames}\n\nDeleting this model will also delete these recipes.\n\nAre you sure you want to continue?`;
        }
        
        if (!confirm(confirmMessage)) {
            return;
        }

        // First, get the training job details to find the storage path
        const { data: jobData, error: jobError } = await supabase
            .from('training_jobs')
            .select('user_id')
            .eq('id', modelId)
            .single();

        if (jobError) throw jobError;

        // Delete any recipes that reference this model
        // This must be done before deleting the training job due to foreign key constraints
        if (recipesUsingModel && recipesUsingModel.length > 0) {
            console.log(`Deleting ${recipesUsingModel.length} recipes that reference this model`);
            const { error: recipesDeleteError } = await supabase
                .from('recipes')
                .delete()
                .or(`roaster_model_id.eq.${modelId},bean_model_id.eq.${modelId}`);

            if (recipesDeleteError) {
                throw new Error(`Failed to delete associated recipes: ${recipesDeleteError.message}`);
            }
        }

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
                
                // Also check for checkpoints subdirectory (completed models keep checkpoints for warm starting)
                const { data: checkpointFileList, error: checkpointListError } = await supabase
                    .storage
                    .from('trained-models')
                    .list(`${storagePath}/checkpoints`, {
                        limit: 1000,
                        sortBy: { column: 'name', order: 'asc' }
                    });

                if (!checkpointListError && checkpointFileList && checkpointFileList.length > 0) {
                    const checkpointFilePaths = checkpointFileList.map(file => `${storagePath}/checkpoints/${file.name}`);
                    filePaths.push(...checkpointFilePaths);
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
 * Initialize model type filter buttons
 * Handles filtering between all models, roaster models, and bean models
 */
function initModelTypeFilters(): void {
    const filterButtons = document.querySelectorAll('.model-type-filter-btn');
    
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const modelType = btn.getAttribute('data-model-type') as 'all' | 'roaster' | 'bean';
            if (!modelType) return;
            
            // Update active button styling
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Update current filter
            currentModelTypeFilter = modelType;
            
            // Reload models with new filter
            loadModels();
        });
    });
}

/**
 * Start periodic refresh of jobs list
 * This keeps the job status and progress updated in real-time
 * Uses smart updates to avoid full page re-renders
 */
function startJobsRefresh(): void {
    setInterval(async () => {
        // Fetch updated data without triggering full re-render
        await refreshJobsData();
        await refreshModelsData();
    }, 10000); // Refresh every 10 seconds
}

/**
 * Refresh jobs data in the background and update UI smartly
 * Only updates what has changed to avoid flickering
 */
async function refreshJobsData(): Promise<void> {
    try {
        const { data, error } = await supabase
            .from('training_jobs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error('Error refreshing jobs:', error);
            return;
        }

        const newJobs = data as TrainingJob[];
        
        // Check if we need to do a full refresh (job count changed or new job status)
        if (newJobs.length !== allJobs.length) {
            // Job count changed - do full refresh
            allJobs = newJobs;
            displayJobs();
            return;
        }
        
        // Check if any job status changed (requires full refresh)
        let statusChanged = false;
        let lossHistoryChanged = false;
        
        for (const newJob of newJobs) {
            const oldJob = allJobs.find(j => j.id === newJob.id);
            if (!oldJob || oldJob.status !== newJob.status) {
                statusChanged = true;
                break;
            }
            
            // Check if loss_history just appeared (job started training)
            // This requires a full re-render to add the progress indicator
            const oldHasLossHistory = oldJob.loss_history?.total && oldJob.loss_history.total.length > 0;
            const newHasLossHistory = newJob.loss_history?.total && newJob.loss_history.total.length > 0;
            
            if (!oldHasLossHistory && newHasLossHistory) {
                lossHistoryChanged = true;
                break;
            }
        }
        
        if (statusChanged || lossHistoryChanged) {
            // Status or loss history changed - do full refresh
            allJobs = newJobs;
            displayJobs();
            return;
        }
        
        // No major changes - just update running jobs incrementally
        allJobs = newJobs;
        
        // Update only running jobs without full re-render
        newJobs.forEach(job => {
            if (job.status === 'running') {
                updateJobCard(job);
            }
        });
        
    } catch (error: any) {
        console.error('Error refreshing jobs data:', error);
    }
}

/**
 * Refresh models data in the background and update UI smartly
 * Only updates the model list if it has actually changed
 */
async function refreshModelsData(): Promise<void> {
    try {
        // Only refresh if we're on the models view
        const modelsView = document.getElementById('models-view');
        if (!modelsView || !modelsView.classList.contains('active')) {
            return; // Don't refresh if not viewing models
        }
        
        const { data, error } = await supabase
            .from('training_jobs')
            .select('*')
            .eq('status', 'completed')
            .order('completed_at', { ascending: false });
        
        if (error) {
            console.error('Error refreshing models:', error);
            return;
        }
        
        const newModels = data as TrainingJob[];
        
        // Apply model type filter
        const filteredNewModels = filterModelsByType(newModels);
        
        // Check if model count changed or we have a new model
        const currentModelsContainer = document.getElementById('models-list');
        const currentModelCards = currentModelsContainer?.querySelectorAll('.model-card');
        const currentModelCount = currentModelCards?.length || 0;
        
        if (filteredNewModels.length !== currentModelCount) {
            // Model count changed - do full refresh
            displayModels(filteredNewModels);
        }
        // If count is the same, we don't need to update (models don't change once completed)
        
    } catch (error: any) {
        console.error('Error refreshing models data:', error);
    }
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
        
        // Initialize model type filters
        initModelTypeFilters();
        
        // Initialize training type selector (for bean training support)
        initTrainingTypeSelector();
        
        // Set up training button handler
        const startTrainingBtn = document.getElementById('start-training-btn');
        if (startTrainingBtn) {
            startTrainingBtn.addEventListener('click', startTraining);
        }
        
        // Set up clear checkpoint button handler
        const clearCheckpointBtn = document.getElementById('clearCheckpointBtn');
        if (clearCheckpointBtn) {
            clearCheckpointBtn.addEventListener('click', clearCheckpoint);
        }
        
        // Load initial data
        await loadModels();
        await loadSysidModels(); // Load system ID models for bean training
        await loadRoasts();
        await loadJobs();
        
        // Start periodic refresh
        startJobsRefresh();
    }
})();
