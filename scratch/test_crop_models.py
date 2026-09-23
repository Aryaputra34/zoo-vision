import os
import cv2
import numpy as np
from ultralytics import YOLO

def main():
    crop_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\user_bamboo_table_crop.jpg"
    crop = cv2.imread(crop_path)
    
    # 1. Test different models and confidences
    models = ["yolo26s.pt", "yolo26m.pt", "yolo26l.pt", "yolo11m.pt"]
    
    for m in models:
        y = YOLO(m)
        print(f"\n=== Model {m} ===")
        for conf in [0.05, 0.08, 0.12, 0.15]:
            res = y(crop, classes=[0], conf=conf, imgsz=640, verbose=False)[0]
            print(f"Conf={conf:.2f} -> Detections: {len(res.boxes)}")
            for b in res.boxes:
                c = float(b.conf[0])
                bx = [int(x) for x in b.xyxy[0].tolist()]
                print(f"   conf={c:.3f}, box={bx}")

if __name__ == "__main__":
    main()
