import os
import cv2
from ultralytics import YOLO

def main():
    model = YOLO("yolo11s.pt")
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    path = os.path.join(upload_dir, "media_1790058289420.jpg")
    img = cv2.imread(path)
    
    results = model(img, classes=[0], conf=0.08, imgsz=1024, verbose=False)[0]
    print(f"Total detections at conf >= 0.08: {len(results.boxes)}")
    for i, box in enumerate(results.boxes):
        conf = float(box.conf[0])
        xyxy = box.xyxy[0].tolist()
        print(f"Box {i}: conf={conf:.3f}, xyxy={[int(x) for x in xyxy]}")

if __name__ == "__main__":
    main()
