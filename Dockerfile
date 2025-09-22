# Dockerfile (Definitive, Final Version)
FROM python:3.9-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies as root
RUN apt-get update && apt-get install -y \
    gosu \
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

# Set the working directory to the user's home directory.
WORKDIR /home/appuser/app

# --- START: CRITICAL FIX ---
# Create the directories for our volumes as the root user FIRST.
RUN mkdir -p /home/appuser/app/config /home/appuser/app/user_data && \
    # Now, give the non-root 'appuser' ownership of these directories.
    # When the volumes are mounted, the permissions will be correct.
    chown -R appuser:appuser /home/appuser/app/config /home/appuser/app/user_data
# --- END: CRITICAL FIX ---

# Copy the requirements file and install them
COPY --chown=appuser:appuser requirements.txt .
# Switch to the non-root user before running pip
USER appuser
RUN pip install --no-cache-dir -r requirements.txt

# Now, copy the application code into the WORKDIR.
# The USER is already appuser, so we don't need --chown here.
COPY ./app/ .
COPY ./config/ ./config/

# Expose the port
EXPOSE 5000

# The CMD will now run as 'appuser' and will have permission to write to the volumes.
CMD ["python", "-u", "main.py"]