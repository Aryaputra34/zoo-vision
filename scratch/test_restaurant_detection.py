import os
import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    model = YOLO("yolo11s.pt")
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    out_dir = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch"
    os.makedirs(out_dir, exist_ok=True)

    img_files = ["media_1790058289420.jpg", "media_1790058312916.jpg"]
    
    for fname in img_files:
        path = os.path.join(upload_dir, fname)
        img = cv2.imread(path)
        if img is None:
            print(f"Could not load {path}")
            continue
        
        # Test at standard 640 and high-res 1280
        for imgsz in [640, 1024]:
            results = model(img, classes=[0], conf=0.25, imgsz=imgsz, verbose=False)[0]
            detections = sv.Detections.from_ultralytics(results)
            print(f"File: {fname} | imgsz: {imgsz} | Detections count: {len(detections)}")
            
            box_annotator = sv.BoxAnnotator(thickness=2)
            label_annotator = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
            
            annotated = img.copy()
            annotated = box_annotator.annotate(annotated, detections=detections)
            labels = [f"person {c:.2f}" for c in detections.confidence]
            annotated = label_annotator.annotate(annotated, detections=detections, labels=labels)
            
            out_name = f"test_{fname.split('.')[0]}_{imgsz}.jpg"
            out_path = os.path.join(out_dir, out_name)
            cv2.imwrite(out_path, annotated)
            print(f"Saved annotated preview to {out_path}")

if __name__ == "__main__":
    main()
