# Dockerfile (Definitive, Corrected Version)
FROM python:3.9-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies as root
RUN apt-get update && apt-get install -y \
    tini \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libcurl4 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libvulkan1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    lsb-release wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y ./google-chrome-stable_current_amd64.deb \
    && rm google-chrome-stable_current_amd64.deb

# Create the non-root user and its home directory
RUN useradd -ms /bin/bash appuser

# Set the working directory to be the main app folder inside the user's home.
WORKDIR /home/appuser/app

# --- START: CRITICAL FIX ---
# Copy the requirements and config files first to leverage Docker build caching.
COPY --chown=appuser:appuser requirements.txt .
COPY --chown=appuser:appuser config/ ./config/

# Copy the session data, respecting the .dockerignore file
COPY --chown=appuser:appuser user_data/ ./user_data/

# Copy the *contents* of the local 'app' folder into the WORKDIR.
COPY --chown=appuser:appuser app/ .
# --- END: CRITICAL FIX ---

# Switch to the non-root user
USER appuser

# Install Python requirements
RUN pip install --no-cache-dir -r requirements.txt

# This port is exposed from within the container
EXPOSE 5000

# Set tini as the entrypoint to properly manage processes
ENTRYPOINT ["/usr/bin/tini", "--"]
# The command will now correctly find main.py in the WORKDIR /home/appuser/app
CMD ["python", "-u", "main.py"]