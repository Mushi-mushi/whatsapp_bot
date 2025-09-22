# Dockerfile (Definitive, Final Version)
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

# Set the working directory
WORKDIR /home/appuser/app

# --- START: CRITICAL PERMISSIONS AND COPY FIX ---
# Create the directories that our volumes will mount to.
# Do this as root so we can set permissions.
RUN mkdir -p /home/appuser/app/config /home/appuser/app/user_data /home/appuser/app/logs && \
    # Give the non-root 'appuser' ownership of these mount points.
    chown -R appuser:appuser /home/appuser/app/config /home/appuser/app/user_data /home/appuser/app/logs

# Copy only the requirements file first to leverage Docker build caching
COPY --chown=appuser:appuser requirements.txt .

# Switch to the non-root user for all subsequent operations
USER appuser

# Install Python requirements as 'appuser'
RUN pip install --no-cache-dir -r requirements.txt
RUN python -m textblob.download_corpora

# Now, copy the application code into the WORKDIR.
# We copy the *contents* of the local 'app' folder, not the folder itself.
COPY --chown=appuser:appuser app/ .
# --- END: CRITICAL PERMISSIONS AND COPY FIX ---

# Expose the port
EXPOSE 5000

# Set tini as the entrypoint to properly manage processes
ENTRYPOINT ["/usr/bin/tini", "--"]
# The CMD will now run as 'appuser' and will have permission to write to the volumes.
CMD ["python", "-u", "main.py"]