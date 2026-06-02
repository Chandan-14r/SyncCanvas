# Deployment Guide — Publish SyncCanvas to the Web for Free

To publish **SyncCanvas** (a Node.js backend with real-time WebSockets and file-based Yjs document storage), we need hosting that supports **persistent WebSocket connections**. 

> [!WARNING]
> **Serverless Limitations**: Standard free hosting sites like **GitHub Pages**, **Vercel**, or **Netlify** are designed for static sites or short-lived serverless functions. They **cannot** run persistent WebSocket connections and will disconnect your Yjs sync within seconds.

The two best free options that support Node.js WebSockets are **Fly.io** and **Render.com**. Below are step-by-step guides for both.

---

## 🚀 Option 1: Fly.io (Recommended)
Fly.io is the best fit for SyncCanvas because their free tier allows you to attach a **persistent storage volume (up to 3GB)** for free. This ensures your saved notes survive app restarts.

### Free Tier Benefits:
* Free custom domain: `https://your-app-name.fly.dev`
* Free SSL certificate (HTTPS/WSS)
* 3GB persistent disk storage
* 3 shared-CPU VMs with 256MB RAM

### Setup Steps:

1. **Install Fly CLI**
   Open PowerShell on your computer and run:
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
   Restart your terminal after installation so `flyctl` is added to your PATH.

2. **Sign Up / Log In**
   Register a free account via terminal:
   ```bash
   fly auth signup
   ```
   *(Note: Fly.io requires a credit card on file for fraud prevention, but you will not be charged if you stay within the free tier).*

3. **Initialize the App**
   Navigate to your project directory `C:\Users\crs14\.gemini\antigravity\scratch\syncanvas` and run:
   ```bash
   fly launch
   ```
   * Choose a unique name for your application.
   * Select a hosting region close to you.
   * When asked if you want to deploy, select **No** (we need to configure the persistent volume first!).

4. **Configure Fly Volume (Persistence)**
   Create a free 1GB persistent volume in the same region you selected during launch:
   ```bash
   fly volumes create syncanvas_data --size 1 --region <your-selected-region>
   ```

5. **Modify `fly.toml`**
   Open the newly generated `fly.toml` file in the root of your project and configure it to mount the volume to the `./data` directory:
   ```toml
   # Add this section at the bottom of fly.toml
   [[mounts]]
     source = "syncanvas_data"
     destination = "/app/data"
   ```

6. **Deploy**
   Run the deployment command:
   ```bash
   fly deploy
   ```
   Once complete, your site will be live at `https://<your-app-name>.fly.dev`!

---

## ☁️ Option 2: Render.com (Easiest Setup)
Render is the easiest platform to deploy directly from a GitHub repository.

### Free Tier Benefits:
* Free custom domain: `https://your-app-name.onrender.com`
* Free SSL certificate (HTTPS/WSS)
* Direct sync with GitHub (auto-deploys on git push)

### 💾 Fully Persistent Storage on Render
* **Ephemeral Storage**: Render's free tier does not support persistent disks. Normally, this means all saved notes would be deleted when the server sleeps (after 15 minutes of inactivity) or restarts.
* **Database Solution**: To fix this, we upgraded the backend persistence layer to automatically detect if a `MONGODB_URI` environment variable is provided. If found, it connects to a database and preserves all notes in the cloud; otherwise, it falls back to local files automatically.

### Setup Steps:

1. **Get a Free MongoDB Database**
   * Go to [MongoDB Atlas](https://www.mongodb.com/products/platform/atlas-database) and sign up for a free Shared Cluster.
   * Create a database user and copy your **connection string** (e.g. `mongodb+srv://username:password@cluster.mongodb.net/syncanvas?retryWrites=true&w=majority`).
   * Make sure to whitelist IP addresses to **Allow Access from Anywhere** (`0.0.0.0/0`) in your Atlas Security Settings so Render can connect.

2. **Push your code to GitHub**
   Create a private or public repository on GitHub and push your SyncCanvas codebase:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   # Link to your repo
   git remote add origin https://github.com/your-username/your-repo-name.git
   git push -u origin main
   ```

3. **Deploy on Render**
   * Go to [dashboard.render.com](https://dashboard.render.com/) and create a free account.
   * Click **New** -> **Web Service**.
   * Connect your GitHub account and select your `syncanvas` repository.
   * Configure the service:
     * **Name**: `syncanvas` (or a custom name)
     * **Language**: `Node`
     * **Build Command**: `npm install`
     * **Start Command**: `npm start`
     * **Instance Type**: `Free`
   * **Add Environment Variable**:
     * Scroll down, click **Advanced**, then click **Add Environment Variable**.
     * Key: `MONGODB_URI`
     * Value: *Your MongoDB Atlas connection string*
   * Click **Deploy Web Service**. Render will build and deploy your app. Your notepad will be active at `https://<your-app-name>.onrender.com` with fully persistent cloud database storage!

---

## 🌐 Custom Domains
Both Fly.io and Render allow you to link a custom domain (e.g. `www.mycollaborationpad.com`) for free if you purchase one later.
* **On Fly.io**: Run `fly certs add www.yourdomain.com` and point your DNS CNAME/A records.
* **On Render**: Go to your Web Service settings page -> **Custom Domains** -> click **Add Custom Domain**.
