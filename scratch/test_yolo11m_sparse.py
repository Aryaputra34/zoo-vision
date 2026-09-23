import os
import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_path = os.path.join(upload_dir, "media_1790058289420.jpg")
    img = cv2.imread(img_path)
    
    model = YOLO("yolo11m.pt")
    res = model(img, classes=[0], conf=0.15, imgsz=1280, verbose=False)[0]
    dets = sv.Detections.from_ultralytics(res)
    print(f"yolo11m at imgsz=1280, conf=0.15 detected: {len(dets)} people")
    for i, (xyxy, conf) in enumerate(zip(dets.xyxy, dets.confidence)):
        print(f"  Person {i}: conf={conf:.3f}, xyxy={[int(x) for x in xyxy]}")

if __name__ == "__main__":
    main()
