# Use lightweight Nginx base image
FROM nginx:alpine

# Copy all project files to Nginx web root directory
COPY . /usr/share/nginx/html

# Expose port 80 for web traffic
EXPOSE 80

# Start Nginx web server
CMD ["nginx", "-g", "daemon off;"]
