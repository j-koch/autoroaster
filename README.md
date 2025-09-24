# Coffee Roaster Digital Twin Webapp

A minimal web application that uses ONNX Runtime Web to run trained coffee roaster neural network models in the browser. This simulator provides a realistic coffee roasting experience with physics-based modeling.

## Features

- **Real-time Simulation**: Physics-based coffee roasting simulation using trained neural networks
- **Complete Roasting Workflow**: Preheat → Charge → Roast → Drop → Reset
- **Interactive Controls**: Adjustable heater power, fan speed, and bean mass
- **Live Visualization**: Real-time temperature and control plots using Plotly.js
- **Authentic Parameters**: Based on actual coffee roasting data and scaling factors

## Quick Start

1. **Start the Server**:
   ```bash
   cd webapp
   python serve.py
   ```

2. **Open in Browser**:
   Navigate to `http://localhost:8000`

3. **Use the Simulator**:
   - Click "Start Preheat" to begin heating the roaster
   - Adjust heater and fan controls as desired
   - When ready (roaster reaches ~150°C), click "Charge Beans"
   - Monitor the roasting process with real-time charts
   - Click "Drop Beans" when roast is complete
   - Use "Reset" to start over

## How It Works

### Neural Network Models

The simulator uses four ONNX models trained on real coffee roasting data:

1. **State Estimator**: Estimates internal roaster states from observable measurements
2. **Roast Stepper**: Physics-based integration of roaster dynamics using Runge-Kutta
3. **Observer**: Maps internal states to measurable temperatures
4. **Bean Model**: Predicts bean thermal capacity based on temperature

### Simulation Parameters

- **Timestep**: Fixed at 1.5 seconds (realistic for coffee roasting)
- **Temperature Range**: 25°C to 250°C (typical roasting range)
- **Bean Mass**: 50-200g (adjustable)
- **Fixed Parameters**:
  - Drum speed: 0.6 (60%)
  - Ambient temperature: 24°C
  - Humidity: 0.5 (50%)

### Roasting Phases

1. **Idle**: System ready to start
2. **Preheating**: Heating roaster to operating temperature (~150-200°C)
3. **Ready**: Roaster preheated, ready for beans
4. **Charging**: Brief transition when adding beans
5. **Roasting**: Active roasting with beans present
6. **Dropped**: Roast complete, beans removed

## Technical Details

### Architecture

- **Frontend**: Pure HTML/CSS/JavaScript with Plotly.js for visualization
- **ML Runtime**: ONNX Runtime Web for neural network inference
- **Models**: Exported from PyTorch using the `export_to_onnx.py` script
- **Server**: Simple Python HTTP server with CORS headers

### Data Scaling

The simulator uses the same scaling factors as the training data:

```javascript
scalingFactors = {
    temperatures: { bean: 100.0, environment: 100.0 },
    controls: { heater: 100.0, fan: 100.0, drum: 100.0 },
    mass: 100.0,
    time: 60.0  // Convert seconds to minutes
}
```

### Model Inputs/Outputs

- **State Estimator**: 15 inputs → 5 latent states
- **Roast Stepper**: 4 states + 8 controls + dt → 4 next states  
- **Observer**: 4 states → 1 measurement
- **Bean Model**: 1 temperature → 1 thermal capacity

## Files Structure

```
webapp/
├── index.html              # Main HTML interface
├── roaster-simulator.js    # Core simulation logic
├── serve.py               # HTTP server script
├── README.md              # This documentation
└── onnx_models/           # Trained neural network models
    ├── state_estimator.onnx
    ├── roast_stepper.onnx
    ├── observer.onnx
    ├── bean_model.onnx
    └── model_metadata.yaml
```

## Customization

### Adjusting Parameters

Edit `roaster-simulator.js` to modify:

- Simulation timestep
- Temperature thresholds for phase transitions
- Fixed parameters (drum speed, ambient conditions)
- Scaling factors

### Adding Features

The modular design makes it easy to add:

- Different roaster types (convection vs drum)
- Additional control inputs
- More sophisticated visualization
- Data logging and export
- Profile following/automation

## Troubleshooting

### Models Not Loading

- Ensure you're accessing via HTTP (not file://)
- Check browser console for CORS errors
- Verify ONNX model files are present in `onnx_models/`

### Simulation Errors

- Check browser console for detailed error messages
- Verify input dimensions match model expectations
- Ensure all required models are loaded successfully

### Performance Issues

- Reduce simulation frequency by increasing timestep
- Limit chart data points for better performance
- Use a modern browser with WebAssembly support

## Development

### Requirements

- Python 3.6+ (for the HTTP server)
- Modern web browser with WebAssembly support
- ONNX Runtime Web (loaded via CDN)
- Plotly.js (loaded via CDN)

### Testing

1. Start the server: `python serve.py`
2. Open browser developer tools
3. Monitor console for errors during model loading
4. Test all roasting phases and controls
5. Verify charts update correctly

## Future Enhancements

- Real-time data export (CSV/JSON)
- Roast profile comparison
- Multiple bean varieties
- Advanced control algorithms (PID, MPC)
- Mobile-responsive design
- WebRTC integration for real roaster control

---

This webapp demonstrates the power of running trained neural networks directly in the browser for real-time simulation and control applications.
