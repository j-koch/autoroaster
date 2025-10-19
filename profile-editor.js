/**
 * Interactive Profile Editor
 * 
 * Provides a visual waypoint-based editor for creating and modifying roast profiles.
 * Users can drag waypoints to adjust temperature curves and see real-time updates.
 */

class InteractiveProfileEditor {
    constructor() {
        // Editor state
        this.isOpen = false;
        this.currentProfile = null;
        this.waypoints = [];  // Array of {time: number, temp: number, id: number}
        this.selectedWaypoint = null;
        this.isDragging = false;
        this.nextWaypointId = 0;
        this.initialized = false;
        
        // Editor constraints
        this.constraints = {
            minTime: 0,
            maxTime: 12,      // 12 minutes maximum
            minTemp: 20,      // 20°C minimum
            maxTemp: 250,     // 250°C maximum
            minWaypoints: 3,  // Need at least start, middle, end
            maxWaypoints: 10  // Maximum 10 waypoints
        };
        
        // Chart dimensions (will be set when modal opens)
        this.chartWidth = 600;
        this.chartHeight = 400;
        this.margin = { top: 20, right: 20, bottom: 50, left: 60 };
        
        // Initialize the modal structure when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initialize());
        } else {
            this.initialize();
        }
    }
    
    /**
     * Initialize the editor (create modal and set up event listeners)
     */
    initialize() {
        if (this.initialized) return;
        this.createEditorModal();
        this.initialized = true;
        console.log('Profile editor initialized');
    }
    
    /**
     * Create the editor modal HTML structure
     */
    createEditorModal() {
        const modalHTML = `
            <div id="profile-editor-overlay" class="profile-editor-overlay hidden">
                <div class="profile-editor-modal">
                    <button class="close-button" id="profile-editor-close" title="Close">&times;</button>
                    
                    <h1>Interactive Profile Editor</h1>
                    
                    <div class="editor-instructions">
                        <p><strong>How to use:</strong> Click anywhere to add waypoints. Click a waypoint to select it, then adjust using the inputs below.</p>
                    </div>
                    
                    <div class="editor-content">
                        <!-- Interactive chart will be rendered here -->
                        <div id="profile-editor-chart"></div>
                        
                        <div class="editor-controls">
                            <div class="control-row">
                                <button id="add-waypoint-btn" class="btn-secondary">
                                    ➕ Add Waypoint
                                </button>
                                <button id="remove-waypoint-btn" class="btn-danger" disabled>
                                    ➖ Remove Selected
                                </button>
                                <button id="reset-profile-btn" class="btn-secondary">
                                    🔄 Reset to Default
                                </button>
                            </div>
                            
                            <div class="waypoint-info" id="waypoint-info">
                                <div class="info-item">
                                    <span class="label">Waypoints:</span>
                                    <span class="value" id="waypoint-count">0</span>
                                </div>
                                <div class="info-item">
                                    <span class="label">Duration:</span>
                                    <span class="value" id="profile-duration">0:00</span>
                                </div>
                                <div class="info-item">
                                    <span class="label">Final Temp:</span>
                                    <span class="value" id="profile-final-temp">0°C</span>
                                </div>
                            </div>
                            
                            <div class="duration-control">
                                <label for="max-time-input">Total Roast Time (minutes)</label>
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <input type="number" id="max-time-input" min="6" max="15" step="0.5" value="12" style="flex: 1; padding: 8px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px;">
                                </div>
                            </div>
                            
                            <div class="selected-waypoint-details" id="selected-waypoint-details" style="display: none;">
                                <h3>Selected Waypoint</h3>
                                <div class="detail-row">
                                    <label for="waypoint-time-input">Time (min):</label>
                                    <input type="number" id="waypoint-time-input" min="0" max="12" step="0.1" />
                                </div>
                                <div class="detail-row">
                                    <label for="waypoint-temp-input">Temperature (°C):</label>
                                    <input type="number" id="waypoint-temp-input" min="20" max="250" step="1" />
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="editor-actions">
                        <button id="profile-editor-cancel" class="btn-secondary">Cancel</button>
                        <button id="profile-editor-save" class="btn-primary">Save Profile</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add styles
        const styleHTML = `
            <style>
                .profile-editor-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.8);
                    z-index: 2000;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    animation: fadeIn 0.3s ease-out;
                }
                
                .profile-editor-overlay.hidden {
                    display: none;
                }
                
                .profile-editor-modal {
                    background-color: white;
                    border-radius: 12px;
                    padding: 30px;
                    max-width: 900px;
                    max-height: 90vh;
                    overflow-y: auto;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                    position: relative;
                    margin: 20px;
                }
                
                .profile-editor-modal h1 {
                    color: #8B4513;
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 24px;
                    text-align: center;
                }
                
                .editor-instructions {
                    background-color: #fff3cd;
                    padding: 12px;
                    border-radius: 6px;
                    margin-bottom: 20px;
                    border-left: 4px solid #8B4513;
                }
                
                .editor-instructions p {
                    margin: 0;
                    font-size: 14px;
                    color: #856404;
                }
                
                .editor-content {
                    display: grid;
                    grid-template-columns: 1fr;
                    gap: 20px;
                    margin-bottom: 20px;
                }
                
                #profile-editor-chart {
                    width: 100%;
                    height: 450px;
                    border: 2px solid #ddd;
                    border-radius: 8px;
                    background-color: #fafafa;
                    cursor: crosshair;
                    position: relative;
                }
                
                .editor-controls {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }
                
                .control-row {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                }
                
                .control-row button {
                    flex: 1;
                    min-width: 150px;
                    font-size: 14px;
                    padding: 10px 16px;
                }
                
                .waypoint-info {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                    padding: 15px;
                    background-color: #f8f9fa;
                    border-radius: 6px;
                }
                
                .duration-control {
                    padding: 15px;
                    background-color: #f8f9fa;
                    border-radius: 6px;
                    margin-top: 15px;
                }
                
                .duration-control label {
                    display: block;
                    font-size: 13px;
                    font-weight: bold;
                    color: #333;
                    margin-bottom: 10px;
                }
                
                .info-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                .info-item .label {
                    font-size: 13px;
                    color: #666;
                    font-weight: bold;
                }
                
                .info-item .value {
                    font-size: 15px;
                    font-weight: bold;
                    color: #8B4513;
                }
                
                .selected-waypoint-details {
                    padding: 15px;
                    background-color: #e8f4f8;
                    border-radius: 6px;
                    border-left: 4px solid #4ECDC4;
                }
                
                .selected-waypoint-details h3 {
                    margin: 0 0 12px 0;
                    font-size: 14px;
                    color: #4ECDC4;
                }
                
                .detail-row {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                
                .detail-row:last-child {
                    margin-bottom: 0;
                }
                
                .detail-row label {
                    font-size: 13px;
                    font-weight: bold;
                    color: #333;
                    min-width: 120px;
                }
                
                .detail-row input {
                    flex: 1;
                    padding: 6px 10px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 14px;
                }
                
                .editor-actions {
                    display: flex;
                    gap: 15px;
                    justify-content: flex-end;
                    margin-top: 20px;
                    padding-top: 20px;
                    border-top: 2px solid #eee;
                }
                
                .editor-actions button {
                    padding: 12px 24px;
                    font-size: 16px;
                    font-weight: bold;
                    min-width: 120px;
                }
                
                /* Waypoint styles */
                .waypoint-circle {
                    fill: #8B4513;
                    stroke: white;
                    stroke-width: 2;
                    cursor: move;
                    transition: all 0.2s ease;
                }
                
                .waypoint-circle:hover {
                    fill: #A0522D;
                    r: 8;
                }
                
                .waypoint-circle.selected {
                    fill: #4ECDC4;
                    stroke: #2a9d8f;
                    stroke-width: 3;
                    r: 9;
                }
                
                .profile-line {
                    fill: none;
                    stroke: #8B4513;
                    stroke-width: 3;
                    opacity: 0.7;
                }
                
                .grid-line {
                    stroke: #ddd;
                    stroke-width: 1;
                    stroke-dasharray: 2, 2;
                }
                
                .axis-line {
                    stroke: #333;
                    stroke-width: 2;
                }
                
                .axis-label {
                    font-size: 12px;
                    fill: #666;
                }
                
                .axis-title {
                    font-size: 14px;
                    font-weight: bold;
                    fill: #333;
                }
                
                /* Mobile responsive */
                @media (max-width: 768px) {
                    .profile-editor-modal {
                        max-width: 95%;
                        padding: 20px;
                    }
                    
                    .profile-editor-modal h1 {
                        font-size: 20px;
                    }
                    
                    #profile-editor-chart {
                        height: 350px;
                    }
                    
                    .control-row button {
                        min-width: 100px;
                        font-size: 12px;
                        padding: 8px 12px;
                    }
                    
                    .waypoint-info {
                        grid-template-columns: 1fr;
                        gap: 10px;
                    }
                }
            </style>
        `;
        
        // Add to document
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // Set up event listeners
        this.setupEventListeners();
    }
    
    /**
     * Set up event listeners for editor controls
     */
    setupEventListeners() {
        // Modal controls
        document.getElementById('profile-editor-close').addEventListener('click', () => this.close());
        document.getElementById('profile-editor-cancel').addEventListener('click', () => this.close());
        document.getElementById('profile-editor-save').addEventListener('click', () => this.saveProfile());
        
        // Editor controls
        document.getElementById('add-waypoint-btn').addEventListener('click', () => this.addWaypoint());
        document.getElementById('remove-waypoint-btn').addEventListener('click', () => this.removeSelectedWaypoint());
        document.getElementById('reset-profile-btn').addEventListener('click', () => this.resetToDefault());
        
        // Waypoint detail inputs
        document.getElementById('waypoint-time-input').addEventListener('change', (e) => this.updateWaypointTime(parseFloat(e.target.value)));
        document.getElementById('waypoint-temp-input').addEventListener('change', (e) => this.updateWaypointTemp(parseFloat(e.target.value)));
        
        // Max time input with increment/decrement arrows
        const maxTimeInput = document.getElementById('max-time-input');
        maxTimeInput.addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            // Constrain value between min and max
            const constrainedValue = Math.max(6, Math.min(15, value));
            this.constraints.maxTime = constrainedValue;
            maxTimeInput.value = constrainedValue;
            if (this.isOpen) {
                this.renderChart();
            }
        });
        
        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }
    
    /**
     * Open the editor with a profile
     * @param {Object} profile - Profile object to edit
     */
    open(profile) {
        // Ensure editor is initialized
        if (!this.initialized) {
            this.initialize();
        }
        
        this.isOpen = true;
        this.currentProfile = profile;
        
        // Extract waypoints from profile (sample every 0.5 minutes)
        this.waypoints = [];
        this.nextWaypointId = 0;
        
        if (profile && profile.times && profile.temps) {
            // Sample waypoints at regular intervals
            const sampleInterval = 0.5; // Sample every 0.5 minutes
            for (let t = 0; t <= profile.times[profile.times.length - 1]; t += sampleInterval) {
                // Find temperature at this time using interpolation
                const temp = this.interpolateTemp(profile.times, profile.temps, t);
                this.waypoints.push({
                    time: t,
                    temp: temp,
                    id: this.nextWaypointId++
                });
            }
            
            // Ensure we have the final point
            const lastTime = profile.times[profile.times.length - 1];
            const lastTemp = profile.temps[profile.temps.length - 1];
            if (this.waypoints[this.waypoints.length - 1].time < lastTime) {
                this.waypoints.push({
                    time: lastTime,
                    temp: lastTemp,
                    id: this.nextWaypointId++
                });
            }
        } else {
            // Create default waypoints if no profile provided
            this.resetToDefault();
        }
        
        // Show modal
        document.getElementById('profile-editor-overlay').classList.remove('hidden');
        
        // Initialize chart
        this.renderChart();
    }
    
    /**
     * Close the editor
     */
    close() {
        this.isOpen = false;
        this.selectedWaypoint = null;
        document.getElementById('profile-editor-overlay').classList.add('hidden');
    }
    
    /**
     * Interpolate temperature at a given time
     */
    interpolateTemp(times, temps, targetTime) {
        if (targetTime <= times[0]) return temps[0];
        if (targetTime >= times[times.length - 1]) return temps[temps.length - 1];
        
        // Find surrounding points
        let i = 0;
        while (i < times.length - 1 && times[i + 1] < targetTime) {
            i++;
        }
        
        // Linear interpolation
        const t1 = times[i];
        const t2 = times[i + 1];
        const T1 = temps[i];
        const T2 = temps[i + 1];
        
        const fraction = (targetTime - t1) / (t2 - t1);
        return T1 + fraction * (T2 - T1);
    }
    
    /**
     * Render the interactive chart using Plotly
     */
    renderChart() {
        // Sort waypoints by time
        this.waypoints.sort((a, b) => a.time - b.time);
        
        // Generate smooth profile from waypoints
        const numPoints = 200;
        const smoothTimes = [];
        const smoothTemps = [];
        
        const maxTime = Math.max(this.constraints.maxTime, this.waypoints[this.waypoints.length - 1].time);
        for (let i = 0; i <= numPoints; i++) {
            const t = (i / numPoints) * maxTime;
            smoothTimes.push(t);
            
            // Interpolate temperature at this time
            const temp = this.interpolateFromWaypoints(t);
            smoothTemps.push(temp);
        }
        
        // Create traces
        const traces = [
            {
                x: smoothTimes,
                y: smoothTemps,
                name: 'Profile',
                line: { color: '#8B4513', width: 3 },
                mode: 'lines',
                hovertemplate: '%{y:.1f}°C at %{x:.2f} min<extra></extra>'
            },
            {
                x: this.waypoints.map(w => w.time),
                y: this.waypoints.map(w => w.temp),
                name: 'Waypoints',
                mode: 'markers',
                marker: {
                    size: 12,
                    color: this.waypoints.map(w => 
                        this.selectedWaypoint && w.id === this.selectedWaypoint.id ? '#4ECDC4' : '#8B4513'
                    ),
                    line: { color: 'white', width: 2 }
                },
                hovertemplate: 'Waypoint: %{y:.1f}°C at %{x:.2f} min<extra></extra>'
            }
        ];
        
        // Layout
        const layout = {
            title: '',
            xaxis: {
                title: 'Time (minutes)',
                range: [0, this.constraints.maxTime],
                gridcolor: '#e0e0e0'
            },
            yaxis: {
                title: 'Temperature (°C)',
                range: [0, 260],
                gridcolor: '#e0e0e0'
            },
            showlegend: false,
            margin: { t: 20, r: 20, b: 50, l: 60 },
            hovermode: 'closest'
        };
        
        // Config - disable drag modes to prevent zoom
        const config = {
            displayModeBar: false,
            responsive: true,
            scrollZoom: false,
            doubleClick: false
        };
        
        // Render chart
        Plotly.newPlot('profile-editor-chart', traces, layout, config);
        
        // Add click handler for selecting waypoints or adding new ones
        const chartDiv = document.getElementById('profile-editor-chart');
        chartDiv.on('plotly_click', (data) => {
            if (data.points && data.points.length > 0) {
                const point = data.points[0];
                
                // Check if clicking on a waypoint
                if (point.curveNumber === 1) {
                    const waypointIndex = point.pointIndex;
                    const clickedWaypoint = this.waypoints[waypointIndex];
                    
                    // If clicking the same waypoint that's already selected, deselect it
                    if (this.selectedWaypoint && this.selectedWaypoint.id === clickedWaypoint.id) {
                        this.deselectWaypoint();
                    } else {
                        // Select the waypoint for editing via input fields
                        this.selectWaypoint(clickedWaypoint);
                    }
                } else {
                    // Clicking on profile line or chart area - add a new waypoint
                    this.addWaypointAt(point.x, point.y);
                }
            } else {
                // Clicking on empty space - deselect any selected waypoint
                this.deselectWaypoint();
            }
        });
        
        // Update cursor based on hover state
        chartDiv.on('plotly_hover', (data) => {
            if (data.points && data.points.length > 0 && data.points[0].curveNumber === 1) {
                chartDiv.style.cursor = 'pointer';
            } else {
                chartDiv.style.cursor = 'crosshair';
            }
        });
        
        chartDiv.on('plotly_unhover', () => {
            chartDiv.style.cursor = 'crosshair';
        });
        
        // Update info display
        this.updateInfoDisplay();
    }
    
    /**
     * Interpolate temperature from waypoints at given time
     */
    interpolateFromWaypoints(time) {
        if (this.waypoints.length === 0) return 25;
        if (time <= this.waypoints[0].time) return this.waypoints[0].temp;
        if (time >= this.waypoints[this.waypoints.length - 1].time) {
            return this.waypoints[this.waypoints.length - 1].temp;
        }
        
        // Find surrounding waypoints
        let i = 0;
        while (i < this.waypoints.length - 1 && this.waypoints[i + 1].time < time) {
            i++;
        }
        
        // Linear interpolation
        const w1 = this.waypoints[i];
        const w2 = this.waypoints[i + 1];
        
        const fraction = (time - w1.time) / (w2.time - w1.time);
        return w1.temp + fraction * (w2.temp - w1.temp);
    }
    
    /**
     * Add a waypoint at the specified position
     */
    addWaypointAt(time, temp) {
        if (this.waypoints.length >= this.constraints.maxWaypoints) {
            alert(`Maximum of ${this.constraints.maxWaypoints} waypoints allowed`);
            return;
        }
        
        // Constrain values
        time = Math.max(this.constraints.minTime, Math.min(this.constraints.maxTime, time));
        temp = Math.max(this.constraints.minTemp, Math.min(this.constraints.maxTemp, temp));
        
        // Add waypoint
        const newWaypoint = {
            time: time,
            temp: temp,
            id: this.nextWaypointId++
        };
        
        this.waypoints.push(newWaypoint);
        this.selectWaypoint(newWaypoint);
        this.renderChart();
    }
    
    /**
     * Add a waypoint at the midpoint
     */
    addWaypoint() {
        if (this.waypoints.length === 0) {
            // Add first waypoint at start
            this.addWaypointAt(0, 25);
        } else if (this.waypoints.length === 1) {
            // Add second waypoint at end
            this.addWaypointAt(10, 220);
        } else {
            // Add waypoint at midpoint of longest segment
            this.waypoints.sort((a, b) => a.time - b.time);
            
            let maxGap = 0;
            let maxGapIndex = 0;
            
            for (let i = 0; i < this.waypoints.length - 1; i++) {
                const gap = this.waypoints[i + 1].time - this.waypoints[i].time;
                if (gap > maxGap) {
                    maxGap = gap;
                    maxGapIndex = i;
                }
            }
            
            // Add at midpoint
            const midTime = (this.waypoints[maxGapIndex].time + this.waypoints[maxGapIndex + 1].time) / 2;
            const midTemp = (this.waypoints[maxGapIndex].temp + this.waypoints[maxGapIndex + 1].temp) / 2;
            
            this.addWaypointAt(midTime, midTemp);
        }
    }
    
    /**
     * Remove the selected waypoint
     */
    removeSelectedWaypoint() {
        if (!this.selectedWaypoint) return;
        
        if (this.waypoints.length <= this.constraints.minWaypoints) {
            alert(`Need at least ${this.constraints.minWaypoints} waypoints`);
            return;
        }
        
        this.waypoints = this.waypoints.filter(w => w.id !== this.selectedWaypoint.id);
        this.selectedWaypoint = null;
        this.renderChart();
        
        // Update UI
        document.getElementById('selected-waypoint-details').style.display = 'none';
        document.getElementById('remove-waypoint-btn').disabled = true;
    }
    
    /**
     * Select a waypoint
     */
    selectWaypoint(waypoint) {
        this.selectedWaypoint = waypoint;
        
        // Update UI
        document.getElementById('selected-waypoint-details').style.display = 'block';
        document.getElementById('waypoint-time-input').value = waypoint.time.toFixed(2);
        document.getElementById('waypoint-temp-input').value = Math.round(waypoint.temp);
        document.getElementById('remove-waypoint-btn').disabled = false;
        
        this.renderChart();
    }
    
    /**
     * Deselect the currently selected waypoint
     */
    deselectWaypoint() {
        if (!this.selectedWaypoint) return;
        
        this.selectedWaypoint = null;
        
        // Update UI
        document.getElementById('selected-waypoint-details').style.display = 'none';
        document.getElementById('remove-waypoint-btn').disabled = true;
        
        this.renderChart();
    }
    
    /**
     * Update selected waypoint time
     */
    updateWaypointTime(newTime) {
        if (!this.selectedWaypoint) return;
        
        newTime = Math.max(this.constraints.minTime, Math.min(this.constraints.maxTime, newTime));
        this.selectedWaypoint.time = newTime;
        this.renderChart();
    }
    
    /**
     * Update selected waypoint temperature
     */
    updateWaypointTemp(newTemp) {
        if (!this.selectedWaypoint) return;
        
        newTemp = Math.max(this.constraints.minTemp, Math.min(this.constraints.maxTemp, newTemp));
        this.selectedWaypoint.temp = newTemp;
        this.renderChart();
    }
    
    /**
     * Reset to default waypoints
     */
    resetToDefault() {
        this.waypoints = [
            { time: 0, temp: 25, id: this.nextWaypointId++ },
            { time: 2, temp: 120, id: this.nextWaypointId++ },
            { time: 5, temp: 180, id: this.nextWaypointId++ },
            { time: 8, temp: 210, id: this.nextWaypointId++ },
            { time: 10, temp: 220, id: this.nextWaypointId++ }
        ];
        this.selectedWaypoint = null;
        
        if (this.isOpen) {
            this.renderChart();
            document.getElementById('selected-waypoint-details').style.display = 'none';
            document.getElementById('remove-waypoint-btn').disabled = true;
        }
    }
    
    /**
     * Update info display
     */
    updateInfoDisplay() {
        document.getElementById('waypoint-count').textContent = this.waypoints.length;
        
        // Duration should reflect the total roast time (maxTime), not just the last waypoint
        const totalTime = this.constraints.maxTime;
        const minutes = Math.floor(totalTime);
        const seconds = Math.round((totalTime - minutes) * 60);
        document.getElementById('profile-duration').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        if (this.waypoints.length > 0) {
            // Final temp is interpolated at the total roast time
            const finalTemp = this.interpolateFromWaypoints(totalTime);
            document.getElementById('profile-final-temp').textContent = `${Math.round(finalTemp)}°C`;
        } else {
            document.getElementById('profile-final-temp').textContent = '0°C';
        }
    }
    
    /**
     * Save the edited profile
     */
    saveProfile() {
        if (this.waypoints.length < this.constraints.minWaypoints) {
            alert(`Need at least ${this.constraints.minWaypoints} waypoints`);
            return;
        }
        
        // Sort waypoints by time
        this.waypoints.sort((a, b) => a.time - b.time);
        
        // Generate high-resolution profile from waypoints
        // Use constraints.maxTime (the Total Roast Time setting), not the last waypoint's time
        const times = [];
        const temps = [];
        
        const maxTime = this.constraints.maxTime;
        const numPoints = Math.ceil(maxTime * 60); // One point per second
        
        for (let i = 0; i <= numPoints; i++) {
            const t = (i / numPoints) * maxTime;
            times.push(t);
            temps.push(this.interpolateFromWaypoints(t));
        }
        
        // Create profile object
        const profile = {
            times: times,
            temps: temps,
            metadata: {
                name: 'Custom Profile',
                description: 'User-created custom roast profile',
                duration: maxTime,
                startTemp: temps[0],
                maxTemp: Math.max(...temps),
                finalTemp: temps[temps.length - 1],
                nWaypoints: this.waypoints.length,
                edited: new Date().toISOString()
            }
        };
        
        // Call the callback to update the simulator
        if (window.simulator && window.simulator.setBackgroundProfile) {
            window.simulator.setBackgroundProfile(profile);
            console.log('Profile saved and applied to simulator:', profile.metadata);
        } else {
            console.error('Simulator not available or setBackgroundProfile method not found');
        }
        
        this.close();
    }
}

// Create global instance
window.profileEditor = new InteractiveProfileEditor();
