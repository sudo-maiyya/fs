FROM python:3.10-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 🔥 THE FIX: Copy ALL Python files into the container
COPY . .

# Expose the Flask port
EXPOSE 5678