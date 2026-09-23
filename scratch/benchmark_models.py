import os
import time
import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_busy_path = os.path.join(upload_dir, "media_1790058312916.jpg")
    img = cv2.imread(img_busy_path)
    
    models = ["yolo11s.pt", "yolo11m.pt"]
    resolutions = [640, 960, 1280]
    
    for m_name in models:
        print(f"\n--- Loading {m_name} ---")
        model = YOLO(m_name)
        for imgsz in resolutions:
            t0 = time.time()
            res = model(img, classes=[0], conf=0.25, imgsz=imgsz, verbose=False)[0]
            elapsed = (time.time() - t0) * 1000
            dets = sv.Detections.from_ultralytics(res)
            print(f"Model: {m_name:<10} | imgsz: {imgsz:<5} | Count: {len(dets):<3} | Time: {elapsed:.0f} ms | Conf mean: {dets.confidence.mean():.2f}")

if __name__ == "__main__":
    main()
