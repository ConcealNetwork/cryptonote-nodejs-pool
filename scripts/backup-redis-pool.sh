#!/bin/bash

BACKUP_DIR="$HOME/backups/redis-pool"
if [ ! -d $BACKUP_DIR ]; then
    mkdir -p $BACKUP_DIR
fi

DATE=$(date +%Y%m%d_%H%M%S)

# Trigger Redis to save
redis-cli BGSAVE

# Wait for completion
sleep 3

# Copy the dump file
cp /var/lib/redis/dump.rdb $BACKUP_DIR/dump_${DATE}.rdb
if [ $? -ne 0 ]; then
    echo "Failed to copy dump file"
else
    echo "Dump file copied successfully"
fi
# If AOF is enabled, backup that too
if [ -f /var/lib/redis/appendonly.aof ]; then
    cp /var/lib/redis/appendonly.aof $BACKUP_DIR/appendonly_${DATE}.aof
    if [ $? -ne 0 ]; then
        echo "Failed to copy appendonly file"
    else
        echo "Appendonly file copied successfully"
    fi
fi

# Keep only last 7 days
find $BACKUP_DIR -name "dump_*.rdb" -mtime +7 -delete
find $BACKUP_DIR -name "appendonly_*.aof" -mtime +7 -delete

echo "$(date): Redis backup completed" >> $BACKUP_DIR/backup.log