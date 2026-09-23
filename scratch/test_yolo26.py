import os
import time
import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_busy_path = os.path.join(upload_dir, "media_1790058312916.jpg")
    img_sparse_path = os.path.join(upload_dir, "media_1790058289420.jpg")
    
    img_busy = cv2.imread(img_busy_path)
    img_sparse = cv2.imread(img_sparse_path)
    
    models = ["yolo11m.pt", "yolo26s.pt", "yolo26m.pt"]
    
    print("================== BUSY FRAME ==================")
    for m in models:
        y = YOLO(m)
        t0 = time.time()
        res = y(img_busy, classes=[0], conf=0.22, imgsz=1280, verbose=False)[0]
        dt = (time.time() - t0) * 1000
        dets = sv.Detections.from_ultralytics(res)
        print(f"Model: {m:<12} | Detections: {len(dets):<3} | Latency: {dt:.0f} ms | Mean Conf: {dets.confidence.mean():.2f}")

    print("\n================== SPARSE FRAME ==================")
    for m in models:
        y = YOLO(m)
        t0 = time.time()
        res = y(img_sparse, classes=[0], conf=0.15, imgsz=1280, verbose=False)[0]
        dt = (time.time() - t0) * 1000
        dets = sv.Detections.from_ultralytics(res)
        print(f"Model: {m:<12} | Detections: {len(dets):<3} | Latency: {dt:.0f} ms | Mean Conf: {dets.confidence.mean():.2f}")
        # check if abaya woman is detected (x ~ 600-750, y ~ 150-360)
        abaya_detected = False
        for box, conf in zip(dets.xyxy, dets.confidence):
            x1, y1, x2, y2 = box
            if 580 <= x1 <= 700 and 140 <= y1 <= 220:
                abaya_detected = True
                print(f"  -> Abaya woman detected! conf={conf:.3f}, box={[int(b) for b in box]}")
        if not abaya_detected:
            print("  -> Abaya woman NOT detected")

if __name__ == "__main__":
    main()
