"""
fyers_login.py
================================================================
DEDICATED FYERS AUTHENTICATION SCRIPT
================================================================
Run this script once a day (or when token expires) to generate a new
access token. It starts a temporary Flask server on port 5678, 
handles the Fyers callback, updates the .env file, and shuts down.
"""

from flask import Flask, request, redirect
from fyers_apiv3 import fyersModel
import os
import threading
import time
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("FYERS_CLIENT_ID")
SECRET_KEY = os.getenv("FYERS_SECRET_KEY")
REDIRECT_URI = os.getenv("FYERS_REDIRECT_URI", "http://103.168.18.1:5678/callback")

if not CLIENT_ID or not SECRET_KEY:
    print("❌ FYERS_CLIENT_ID or FYERS_SECRET_KEY missing in .env")
    exit(1)

app = Flask(__name__)

@app.route("/login")
def login():
    """Generates the Fyers login URL and redirects the user."""
    session = fyersModel.SessionModel(
        client_id=CLIENT_ID,
        secret_key=SECRET_KEY,
        redirect_uri=REDIRECT_URI,
        response_type="code",
        grant_type="authorization_code"
    )
    login_url = session.generate_authcode()
    print(f"🔗 Redirecting to Fyers Login: {login_url}")
    return redirect(login_url)

@app.route("/callback")
def callback():
    """Handles the callback from Fyers, generates token, and saves to .env."""
    auth_code = request.args.get("auth_code")
    
    if not auth_code:
        return "❌ Auth code missing from callback URL."

    session = fyersModel.SessionModel(
        client_id=CLIENT_ID,
        secret_key=SECRET_KEY,
        redirect_uri=REDIRECT_URI,
        response_type="code",
        grant_type="authorization_code"
    )

    session.set_token(auth_code)
    response = session.generate_token()

    if "access_token" not in response:
        print(f"❌ Token Generation Failed! Response: {response}")
        return f"Error: {response.get('message', 'Unknown error')}"

    access_token = response["access_token"]
    
    # Safely update the .env file
    env_path = "/opt/quantengine/footprint-system/.env"
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            lines = f.readlines()
    else:
        lines = []

    with open(env_path, "w") as f:
        token_updated = False
        for line in lines:
            if line.startswith("FYERS_ACCESS_TOKEN"):
                f.write(f"FYERS_ACCESS_TOKEN={access_token}\n")
                token_updated = True
            else:
                f.write(line)
        if not token_updated:
            f.write(f"FYERS_ACCESS_TOKEN={access_token}\n")

    print("\n✅ Token successfully generated and saved to .env!")
    print("🛑 Shutting down login server. You can now start the main engine.")
    
    # Shutdown the temporary Flask server
    func = request.environ.get('werkzeug.server.shutdown')
    if func is None:
        os._exit(0)
    func()
    
    return "✅ Login successful! Token saved to .env. You can close this window and start the main engine."

if __name__ == "__main__":
    print("=========================================================")
    print("🔑 FYERS LOGIN SERVER STARTED")
    print(f"👉 Go to: http://103.168.18.1:5678/login")
    print("=========================================================")
    app.run(host="0.0.0.0", port=5678, debug=False)