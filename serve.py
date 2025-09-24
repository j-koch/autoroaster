#!/usr/bin/env python3
"""
Simple HTTP server for the Coffee Roaster Digital Twin webapp.

This server is needed because ONNX Runtime Web requires files to be served
over HTTP (not file://) due to CORS restrictions when loading ONNX models.

Usage:
    python serve.py [port]

Default port is 8000. Open http://localhost:8000 in your browser.
"""

import http.server
import socketserver
import sys
import os
from pathlib import Path

def main():
    # Get port from command line argument or use default
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port number: {sys.argv[1]}")
            sys.exit(1)
    
    # Change to the webapp directory
    webapp_dir = Path(__file__).parent
    os.chdir(webapp_dir)
    
    # Create HTTP server
    handler = http.server.SimpleHTTPRequestHandler
    
    # Add CORS headers to allow ONNX model loading
    class CORSRequestHandler(handler):
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*')
            super().end_headers()
    
    with socketserver.TCPServer(("", port), CORSRequestHandler) as httpd:
        print(f"☕ Coffee Roaster Digital Twin Server")
        print(f"Serving at http://localhost:{port}")
        print(f"Press Ctrl+C to stop the server")
        print()
        print(f"Open http://localhost:{port} in your web browser to use the simulator")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == "__main__":
    main()
